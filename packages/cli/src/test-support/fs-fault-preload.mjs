import { installFsFaults } from './fs-fault.mjs';

const encoded = process.env.FORGEKIT_TEST_FS_FAULTS;
if (encoded) installFsFaults(JSON.parse(encoded));
