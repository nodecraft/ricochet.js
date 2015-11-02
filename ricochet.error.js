'use strict';
// https://gist.github.com/justmoon/15511f92e5216fa2624b

module.exports = function CustomError(message, extra){
	Error.captureStackTrace(this, this.constructor);
	this.name = this.constructor.name;
	this.message = message;
	this.extra = extra;
};

require('util').inherits(module.exports, Error);