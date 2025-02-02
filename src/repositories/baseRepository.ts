import { IConfig } from 'config';
import mongodb from 'mongodb';
import { DBError } from '../errors/errors';
import { ILogger } from '../services/logger';

export abstract class BaseRepository {
  protected _collection: mongodb.Collection;
  protected _logger: ILogger;
  protected _repoName: string;
  protected _config: IConfig;

  constructor(config: IConfig, logger: ILogger, repoName: string, collection: mongodb.Collection) {
    this._logger = logger;
    this._config = config;
    this._repoName = repoName;
    this._collection = collection;
  }

  private promiseTimeoutS(seconds, promise, errMsg) {
    const timeout = new Promise((resolve, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new DBError(`${errMsg} --> Timed out in ${seconds} seconds.`));
      }, 1000 * seconds);
    });
    return Promise.race([promise, timeout]);
  }

  protected async insertMany(docs: Array<any>, errorMsg: string): Promise<any> {
    try {
      const insertManyResult = await this.promiseTimeoutS(
        this._config.get('MONGO_TIMEOUT_S'),
        this._collection.insertMany(docs),
        errorMsg
      );
      if (insertManyResult?.insertedIds) {
        return insertManyResult.insertedIds;
      }
      return null;
    } catch (error) {
      this._logger.error(`${this._repoName}:upsert`, `Failed to insert job (${JSON.stringify(docs)}) error: ${error}`);
      throw error;
    }
  }

  protected async upsert(filterDoc: any, updateDoc: any, errorMsg: string): Promise<any> {
    try {
      const updateResult = await this.promiseTimeoutS(
        this._config.get('MONGO_TIMEOUT_S'),
        this._collection.updateOne(filterDoc, updateDoc, { upsert: true }),
        errorMsg
      );
      if (updateResult.upsertedId) {
        return updateResult.upsertedId;
      }
      return null;
    } catch (error) {
      this._logger.error(
        `${this._repoName}:upsert`,
        `Failed to insert job (${JSON.stringify(filterDoc)}) error: ${error}`
      );
      throw error;
    }
  }

  private async update(query: any, update: any, errorMsg: string): Promise<any> {
    return await this.promiseTimeoutS(
      this._config.get('MONGO_TIMEOUT_S'),
      this._collection.updateOne(query, update),
      errorMsg
    );
  }

  protected async findOne(query: any, errorMsg: string): Promise<any> {
    try {
      return await this.promiseTimeoutS(this._config.get('MONGO_TIMEOUT_S'), this._collection.findOne(query), errorMsg);
    } catch (error) {
      this._logger.error(`${this._repoName}:findOne`, `Failed to find (${JSON.stringify(query)}) error: ${error}`);
      throw error;
    }
  }
  protected async updateOne(query: any, update: any, errorMsg: string): Promise<boolean> {
    try {
      const updateResult = await this.update(query, update, errorMsg);
      if ((updateResult?.modifiedCount ?? 0) < 1) {
        throw new DBError(`Failed to update job (${JSON.stringify(query)}) for ${JSON.stringify(update)}`);
      }
    } catch (error) {
      this._logger.error(
        `${this._repoName}:updateOne`,
        `Failed to update  (${JSON.stringify(query)}) for ${JSON.stringify(update)} Error: ${error.message}`
      );
      throw error;
    }
    return true;
  }
  protected async findOneAndUpdate(query: any, update: any, options: any, errorMsg: string): Promise<any> {
    try {
      return await this.promiseTimeoutS(
        this._config.get('MONGO_TIMEOUT_S'),
        this._collection.findOneAndUpdate(query, update, options),
        errorMsg
      );
    } catch (error) {
      this._logger.error(
        `${this._repoName}:findOneAndUpdate`,
        `Failed to findOneAndUpdate (${JSON.stringify(query)}) for ${JSON.stringify(
          update
        )} with options ${JSON.stringify(options)} error: ${error}`
      );
      throw error;
    }
  }
}
