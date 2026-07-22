const { syncRxCatalog } = require("../lib/rx-catalog-sync");

syncRxCatalog()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(`RX catalogue sync failed: ${error.message}`);
    process.exit(1);
  });
