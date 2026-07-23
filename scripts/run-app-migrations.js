const { runMigrations } = require("../lib/migrations");

runMigrations()
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
