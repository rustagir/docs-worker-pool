module.exports = {
  env: {
    browser: true,
    es6: true,
  },
  extends: 'plugin:@typescript-eslint/recommended',
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
  rules: {
    'no-console': 'off',
  },
};
