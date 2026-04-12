/** @type {import('vitest/config').UserConfig} */
module.exports = {
  test: {
    include: ['tests/**/*.test.js'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true
      }
    }
  }
};
