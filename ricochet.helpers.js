'use strict';
module.exports = function(config){
	var	util = require('util'),
		crypto = require('crypto');

	var _ = require('lodash');

	var ricochetHelpersError = require('./ricochet.error.js');
	var errors = require('./ricochet.errors.json');

	return {
		error: function(code, obj){
			code = 'ricochet.' + code;
			if(!errors[code]){
				throw new ricochetHelpersError("No error code found to match: " + code);
			}
			var err = {
				Error: errors[code],
				code: code
			};
			if(obj && typeof(obj) === 'object'){
				err = _.defaults(obj, err);
			}
			return err;
		},
		has: function(obj, check){
			if(typeof check === 'string'){
				return _.has(obj, check);
			}
			var result = true;
			_.each(check, function(single){
				if(!_.has(obj, single)){
					result = false;
				}
			});
			return result;
		},
		md5: function(data){
			return crypto.createHash('md5').update(data).digest("hex");
		},
		parseJSON: function(data, callback){
			callback = callback || function(err, msg){
				if(err){
					return false;
				}
				return msg;
			};
			var msg, error;
			try{
				msg = JSON.parse(data);
			}catch(err){
				error = err;
			};
			if(error || !msg){
				return callback({
					Error: error || 'Unable to parse raw JSON data'
				});
			}
			return callback(null, msg);
		},
		encrypt: function(key, data, concat){
			concat = concat || "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n";
			data = util.format('%s%s%s', data, config.delimiters.encryption, concat);
			var cipher = crypto.createCipher(config.encryption, key);
			return cipher.update(String(data), 'utf8', 'hex') + cipher.final('hex');
		},
		decrypt: function(key, data){
			var decipher = crypto.createDecipher(config.encryption, key),
				rawData = String(decipher.update(String(data), 'hex', 'utf8') + decipher.final('utf8')).trim(),
				splitData = rawData.split(config.delimiters.encryption);
			return splitData[0] || false;
		},
		generateCode: function(length, seperator){
			length = length || 32;
			seperator = seperator || false;

			var text = "",
		   		possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		   	if(seperator !== false){
		    	regex = new RegExp('.{' + seperator + '}', 'g');
		   	}
		    for(var i = 0; i < length; i++){
		        text += possible.charAt(Math.floor(Math.random() * possible.length));
		    }
			return seperator && text.match(regex).join('-') || text;
		}
	};
};