// Where the Python service keeps its storage/ tree.
//
// Packaged: the per-user app data folder, which is also what main.js passes to
// the frozen service as `--service-root`. Development: the app/service checkout,
// the service's own default. Everything Electron writes on the service's
// behalf (downloaded task node archives, extracted nodes, the model registry)
// must go under this root, never next to the code.
const path = require('path');

function getServiceRoot(app) {
  if (process.env.TL_SERVICE_ROOT) return process.env.TL_SERVICE_ROOT;
  if (app && app.isPackaged) return app.getPath('userData');
  return path.join(__dirname, '..', '..', 'service');
}

module.exports = { getServiceRoot };
