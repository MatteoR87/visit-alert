// npm run prova: la stessa prova di /api/test-prenota, dal proprio PC.
import { diagnosi } from "../lib/diagnosi.js";

const esito = await diagnosi();
console.log(JSON.stringify(esito, null, 2));
process.exitCode = esito.ok ? 0 : 1;
