'use strict';

// Mirrors how Metro drives jest-worker: the whole chain is CommonJS, and the fork
// TARGET (processChild.js) is reached only via require.resolve() in this process.
const { runTask } = require('fake-jest-worker');

runTask('input-1').then((result) => {
  console.log(`ENTRY result=${result}`);
});
