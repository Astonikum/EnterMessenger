const path = require("node:path");

process.chdir(path.resolve(__dirname, ".."));
process.argv = [process.argv[0], "react-native", "config"];
require("@react-native-community/cli").run();
