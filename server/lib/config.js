/* Configuration and paths, in one place.

   Two things this fixes:
     - .env is loaded from THIS directory, not the process working directory, so the
       documented `node server/server.js` from the repo root actually reads it.
     - every data file is addressed through dataPath(), so a module in server/lib/
       cannot accidentally resolve "..\/data" to server/data instead of <repo>/data.
*/
const path = require("path");

// <repo>/server/lib -> <repo>
const ROOT = path.join(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");

const cfg = (k, f = "") => {
  const v = process.env[k];
  return v === undefined || v === "" ? f : v;
};

const dataPath = (name) => path.join(DATA_DIR, name);
const publicPath = (name) => path.join(PUBLIC_DIR, name);

module.exports = { ROOT, DATA_DIR, PUBLIC_DIR, cfg, dataPath, publicPath };
