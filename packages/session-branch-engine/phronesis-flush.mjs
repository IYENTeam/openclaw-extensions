import { createHttpPhronesisMediation } from './phronesis-http-mediation.mjs';
import { flushPhronesisSpool } from './phronesis-spool.mjs';

const mediation = createHttpPhronesisMediation();
const result = await flushPhronesisSpool(mediation);
console.log(JSON.stringify(result, null, 2));
