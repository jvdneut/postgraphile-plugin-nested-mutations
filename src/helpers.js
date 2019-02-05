const { inspect } = require('util');
const fs = require('fs');

module.exports = (filename, o) => {
	fs.writeFileSync(filename, inspect(o, { maxArrayLength: null, depth: null }));
};
