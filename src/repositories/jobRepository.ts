import * as mongodb from 'mongodb';
import { BaseRepository } from './baseRepository';
import { jobMap, BuildJob, ManifestJob, JobStatus } from '../entities/job';
import { ILogger } from '../services/logger';
import c, { IConfig } from 'config';
import { InvalidJobError, JobExistsAlreadyError, JobNotFoundError } from '../errors/errors';
import { IQueueConnector, SQSConnector } from '../services/queue';
import { JobQueueMessage } from '../entities/queueMessage';

const objectId = mongodb.ObjectId;

export class JobRepository extends BaseRepository {
  private _queueConnector: IQueueConnector;
  constructor(db: mongodb.Db, config: IConfig, logger: ILogger) {
    super(config, logger, 'JobRepository', db.collection(config.get('jobQueueCollection')));
    this._queueConnector = new SQSConnector(logger, config);
  }

  async updateWithCompletionStatus(id: string, result: any): Promise<boolean> {
    const query = { _id: id };
    const update = {
      $set: {
        status: 'completed',
        endTime: new Date(),
        result,
      },
    };
    const bRet = await this.updateOne(
      query,
      update,
      `Mongo Timeout Error: Timed out while updating success status for jobId: ${id}`
    );
    if (bRet) {
      await this._queueConnector.sendMessage(
        new JobQueueMessage(id, JobStatus.completed),
        this._config.get('jobUpdatesQueueUrl'),
        0
      );
    }
    return bRet;
  }

  async insertJob(job: BuildJob | ManifestJob): Promise<void> {
    const filterDoc = { payload: job.payload, status: { $in: ['inQueue', 'inProgress'] } };
    const updateDoc = {
      $setOnInsert: job,
    };
    const jobId = await this.upsert(filterDoc, updateDoc, `Mongo Timeout Error: Timed out while inserting Job`);
    if (!jobId) {
      throw new JobExistsAlreadyError(`InsertJobFailed`);
    }
    // Insertion/re-enqueueing should be sent to jobs queue and updates for an existing job should be sent to jobUpdates Queue
    await this._queueConnector.sendMessage(
      new JobQueueMessage(jobId, JobStatus.inQueue),
      this._config.get('jobsQueueUrl'),
      0
    );
  }

  // TODO: Rewrite or collapse for Build/Manifest functionality
  async getJobById(id: string): Promise<BuildJob | ManifestJob | null> {
    const query = {
      _id: new objectId(id),
    };
    const resp = await this.findOne(query, `Mongo Timeout Error: Timed out while find job by id Job`);
    if (!resp) {
      throw new JobNotFoundError('GetJobByID Failed');
    } else if (resp.value) {
      const jt = resp?.value?.payload?.jobType;
      const job = Object.assign(new jobMap[jt](), resp.value);
      await this.notify(job._id, c.get('jobUpdatesQueueUrl'), JobStatus.inProgress, 0);
      return job;
    }
    return null;
  }

  // TODO: Rewrite or collapse for Build/Manifest functionality
  async getJobByIdAndUpdate(id: string): Promise<BuildJob | ManifestJob | null> {
    const query = {
      _id: new objectId(id),
    };
    return await this.findOneAndUpdateJob(query);
  }

  async notify(jobId: string, url: string, status: JobStatus, delay: number) {
    await this._queueConnector.sendMessage(new JobQueueMessage(jobId, status), url, delay);
  }

  // TODO: Cut down on excess functions? (e.g. take _id and build query within)
  async findOneAndUpdateJob(query): Promise<BuildJob | ManifestJob | null> {
    const update = { $set: { startTime: new Date(), status: 'inProgress' } };
    const options = { sort: { priority: -1, createdTime: 1 }, returnNewDocument: true };
    const resp = await this.findOneAndUpdate(
      query,
      update,
      options,
      `Mongo Timeout Error: Timed out while retrieving job`
    );
    if (!resp) {
      throw new InvalidJobError('JobRepository:getOneQueuedJobAndUpdate retrieved Undefined job');
    } else if (resp.value) {
      const jt = resp?.value?.payload?.jobType;
      const job = Object.assign(new jobMap[jt](), resp.value);
      await this.notify(job._id, c.get('jobUpdatesQueueUrl'), JobStatus.inProgress, 0);
      return job;
    }
    return null;
  }

  // TODO: Rewrite or collapse for Build/Manifest functionality
  async getOneQueuedJobAndUpdate(): Promise<BuildJob | ManifestJob | null> {
    const query = {
      status: 'inQueue',
      createdTime: { $lte: new Date() },
    };
    return await this.findOneAndUpdateJob(query);
  }

  async updateWithErrorStatus(id: string, reason: string): Promise<boolean> {
    const query = { _id: id };
    const update = {
      $set: { status: 'failed', endTime: new Date(), error: { time: new Date().toString(), reason: reason } },
    };
    const bRet = await this.updateOne(
      query,
      update,
      `Mongo Timeout Error: Timed out while updating failure status for jobId: ${id}`
    );
    if (bRet) {
      await this.notify(id, c.get('jobUpdatesQueueUrl'), JobStatus.inProgress, 0);
    }
    return bRet;
  }

  async insertLogStatement(id: string, messages: Array<string>): Promise<boolean> {
    const query = { _id: id };
    const update = {
      $push: { ['logs']: { $each: messages } },
    };
    return await this.updateOne(
      query,
      update,
      `Mongo Timeout Error: Timed out while inserting log statements for jobId: ${id}`
    );
  }

  async insertNotificationMessages(id: string, message: string): Promise<boolean> {
    const query = { _id: id };
    const update = {
      $push: { comMessage: message },
    };
    return await this.updateOne(
      query,
      update,
      `Mongo Timeout Error: Timed out while inserting notification messages for jobId: ${id}`
    );
  }

  async insertPurgedUrls(id: string, urlArray: Array<string>): Promise<boolean> {
    const query = { _id: id };
    const update = {
      $push: { ['purgedURLs']: urlArray },
    };
    return await this.updateOne(
      query,
      update,
      `Mongo Timeout Error: Timed out while inserting purged urls for jobId: ${id}`
    );
  }

  async resetJobStatus(id: string, status: string, reenqueueMessage: string) {
    const query = { _id: id };
    const update = {
      $set: {
        status: status,
        startTime: null,
        error: {},
        logs: [reenqueueMessage],
      },
    };
    const bRet = await this.updateOne(
      query,
      update,
      `Mongo Timeout Error: Timed out finishing re-enqueueing job for jobId: ${id}`
    );

    if (bRet) {
      // Insertion/re-enqueueing should be sent to jobs queue and updates for an existing job should be sent to jobUpdates Queue
      await this.notify(id, c.get('jobsQueueUrl'), JobStatus.inProgress, 0);
    }
    return bRet;
  }
}
