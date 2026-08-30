import { SPEC_VERSION } from '@corpobrain/core';

const [command = 'help'] = process.argv.slice(2);

switch (command) {
  case 'version':
    console.log(`corpobrain spec ${SPEC_VERSION}`);
    break;
  default:
    console.log(`corpobrain <command>

Commands (Phase 1 will add index/search/backlinks/rebuild):
  version     print spec version
`);
}
