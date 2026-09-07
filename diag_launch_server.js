// Launcher for validation on a different port (does not touch the user's running server)
process.env.PORT = "5001";
require("./server.js");