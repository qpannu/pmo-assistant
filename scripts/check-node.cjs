// Runs before npm start/dev/test. Kept syntax-compatible with old Node versions
// so it can explain the problem instead of failing with "bad option".
var required = 24;
var major = Number(process.versions.node.split('.')[0]);
if (major < required) {
  console.error('\nPMO Assistant needs Node ' + required + '+, but this terminal is using Node ' + process.versions.node + '.');
  console.error('Fix: run `nvm use` in the project folder (it reads .nvmrc), then try again.\n');
  process.exit(1);
}
