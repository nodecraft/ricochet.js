'use strict';

var net = require('net'),
	util = require('util');

var _ = require('lodash'),
	async = require('async'),
	eventEmitter2 = require('eventemitter2'),
	jsonStream = require('json-stream');

var ricochetServerError = require('./ricochet.error.js');
var ipv6Mask = /^\:\:ffff\:((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/;

var ricochetServer = function(config){
	var self = this;

	this.config =_.defaults(config || {}, require('./ricochet.defaults.json'));
	this.helpers = require('./ricochet.helpers.js')(this.config);

	this.server = null;
	this.clients = {};
	this.stats = 0;

	// callback methods
	this.authCallback = null;
	this.unroutedCallback = null;

	this.bufferQueue = async.queue(function(data, cb){
		return self.processMessage(data, function(err){
			if(err){
				err.raw = data;
				self.emit('messageError', err);
			}
			return cb();
		});
	}, this.config.queueSize);

	eventEmitter2.EventEmitter2.call(this);
	this.setupMessageError();
};
util.inherits(ricochetServer, eventEmitter2.EventEmitter2);


// Private Methods

ricochetServer.prototype.setupMessageError = function(){
	var self = this;
	this.on('messageError', function(data){
		if(data.message){
			self.handleMessage({
				id: data.id,
				message: {
					headers: {
						id: data.message.headers.id,
						from: data.message.headers.to,
						to: data.message.headers.from,
						type: 'reply',
						status: 'error',
						encrypted: data.message.headers.encrypted || false,
						groups: data.message.headers.groups
					},
					body: {
						error: data.Error,
						code: data.code
					}
				}
			});
		}
	});
}
ricochetServer.prototype.stat = function(channel, what){
	var clientMap = this.getClientMap();
	if(clientMap[channel] && this.clients[clientMap[channel]] && this.clients[clientMap[channel]].stats[what]){
		this.clients[clientMap[channel]].stats[what]++;
	}
}
ricochetServer.prototype.getUniqueCode = function(){
	var code = this.helpers.generateCode();
	if(this.clients[code] !== undefined){
		return this.getUniqueCode();
	}
	return code;
}
ricochetServer.prototype.getClientMap = function(){
	var map = {},
		self = this;
	_.each(self.clients, function(client, id){
		map[client.channel] = id;
	});
	return map;
}
ricochetServer.prototype.resolveIP = function(ip, family){
	if(family == 'IPv6'){
		var test = ipv6Mask.exec(ip);
		if(test && test[1] && net.isIPv4(test[1])){
			return test[1];
		}
	}
	return ip;
}
ricochetServer.prototype.destroyClient = function(id){
	var self = this;
	if(self.clients[id]){
		if(self.clients[id].socket){
			self.clients[id].socket.end();
		}
		self.emit('clientDisconnected', {
			id: id
		});
		delete self.clients[id];
	}
}
ricochetServer.prototype.handleConnection = function(client){
	var self = this;

	client.id = this.getUniqueCode();
	client.setEncoding(this.config.encoding);
	client.setNoDelay(true);

	// add to client list
	this.clients[client.id] = {
		socket: client,
		ip: this.resolveIP(client.remoteAddress, client.remoteFamily),
		buffer: '',
		auth: false,
		channel: null,
		groups: [],
		privateKey: null,
		publicKey: null,
		stats: {
			sent: 0,
			received: 0
		}
	};

	this.emit('clientConnected', {
		id: client.id,
		ip: client.remoteAddress
	});

	setTimeout(function(){
		if(self.clients[client.id] && !self.clients[client.id].auth){
			self.emit('clientAuthFail', self.helpers.error('auth_timeout', {ip: client.remoteAddress}));
			return self.destroyClient(client.id);
		}
	}, self.config.timeouts.auth);
	client.on('error', function(err){
		return self.emit('clientError', {
			id: client.id,
			Error: err
		});
	});
	_.each(['error', 'timeout', 'end'], function(event){
		client.on(event, function(data){
			if(typeof(data) === 'object'){
				data.id = client.id;
			}else{
				data = {
					id: client.id,
					data: data || null
				};
			}
			return self.emit('client' + _.capitalize(event), data);
		});
	});
	client.on('close', function(){
		return self.destroyClient(client.id);
	});

	var json = client.pipe(jsonStream());

	json.on('data', function(msg){
		var data = {
			id: client.id,
			message: msg
		};

		self.emit('clientInput', data);
		return self.bufferQueue.push(data);
	});
}
ricochetServer.prototype.handleAuth = function(data, callback){
	var self = this;
	if(!this.helpers.has(data.message, ['publicKey', 'authKey', 'authStamp'])){
		return callback(self.helpers.error('auth_malformed'));
	}
	var client = self.clients[data.id];
	this.authCallback(data.message, function(err, results){
		if(err){
			return callback(self.helpers.error('auth_failure', {Error: err}));
		}
		if(!self.helpers.has(results, ['ip', 'privateKey', 'publicKey', 'authKey', 'channel', 'groups'])){
			return callback(self.helpers.error('auth_lookup'));
		}
		if(results.groups !== true && (!(results.groups instanceof Array) || results.groups.length == 0)){
			return callback(self.helpers.error('auth_nogroups', {
				provided: results.groups,
			}));
		}
		if(results.ip !== client.ip){
			return callback(self.helpers.error('auth_ip', {
				provided: client.ip,
				expected: results.ip
			}));
		}
		var authkey = self.helpers.decrypt(results.privateKey, data.message.authKey);
		if(authkey !== results.authKey){
			return callback(self.helpers.error('auth_authkey', {
				provided: authkey,
				expected: results.authKey
			}));
		}
		var time = new Date().getTime,
			timestamp = parseInt(self.helpers.decrypt(results.privateKey, data.message.authStamp));
		if(isNaN(timestamp) || timestamp > time + self.config.timeouts.authKey){
			return callback(self.helpers.error('auth_expiredkey', {
				provided: timestamp,
				expected: time
			}));
		}

		var clientMap = self.getClientMap();
		if(clientMap[results.channel]){
			return callback(self.helpers.error('auth_channel', {
				provided: results.channel
			}));
		}
		return callback(null, results);
	});
}
ricochetServer.prototype.processMessage = function(data, callback){
	var self = this;
	callback = callback || function(){};

	if(!this.clients[data.id]){
		return callback(self.helpers.error('message_noclient'));
	}

	if(!self.clients[data.id].auth){
		return self.handleAuth(data, function(err, results){
			var msg = {
				auth: false
			}
			if(!err){
				self.clients[data.id].auth = true;
				_.each(['privateKey', 'publicKey', 'channel', 'groups'], function(type){
					self.clients[data.id][type] = results[type];
				});
				msg.auth = true;
				msg.channel = results.channel;
				msg.groups = results.groups;
			}
			if(!self.clients[data.id] || !self.clients[data.id].socket){
				return callback()
			}
			self.clients[data.id].socket.write(JSON.stringify(msg) + self.config.delimiters.message, function(){
				if(err){
					self.emit('clientAuthFail', err);
					self.destroyClient(data.id);
				}else{
					self.emit('clientReady', {
						id: data.id
					});
				}
				return callback(err); // remove error to prevent wrong event
			})
		});
	}
	self.parseMessage(data, callback);
}
ricochetServer.prototype.parseMessage = function(data, callback){
	if(!this.clients[data.id]){
		return callback(this.helpers.error('message_noclient'));
	}
	if(!this.clients[data.id].auth){
		return callback(this.helpers.error('message_auth'));
	}
	if(!this.helpers.has(data.message, 'headers', 'body') || !this.helpers.has(data.message.headers, ['id', 'type', 'handle', 'to'])){
		return callback(this.helpers.error('message_malformed'));
	}
	var client = this.clients[data.id];

	data.message.headers.from = client.channel;
	data.message.headers.groups = client.groups;

	if(data.message.headers.encrypted){
		data.message.body = this.helpers.parseJSON(this.helpers.decrypt(client.privateKey, data.message.body));
		if(!data.message.body){
			return callback(this.helpers.error('message_decrypt', {message: data.message}));
		}
	}
	this.handleMessage(data, callback);
}
ricochetServer.prototype.handleMessage = function(data, callback){
	var self = this,
		clientMap = self.getClientMap();
	callback = callback || function(){};

	if(data.message.headers.from === data.message.headers.to){
		return callback(self.helpers.error('message_self', {message: data.message}));
	}

	if(!clientMap[data.message.headers.to] || !self.clients[clientMap[data.message.headers.to]]){
		if(!self.unroutedCallback){
			return callback(self.helpers.error('message_norecipient', {message: data.message}));
		}
		return self.unroutedCallback(data, function(err){
			if(err){
				return callback(self.helpers.error(err, {message: data.message}));
			}
			return callback();
		});
	}
	var recipient = self.clients[clientMap[data.message.headers.to]];
	if(recipient.groups !== true && _.intersection(data.message.headers.groups, recipient.groups).length === 0){
		return callback(self.helpers.error('message_group', {message: data.message}));
	}
	if(data.message.headers.encrypted){
		data.message.body = self.helpers.encrypt(recipient.privateKey, JSON.stringify(data.message.body), data.message.id);
	}
	recipient.socket.write(JSON.stringify(data.message) + self.config.delimiters.message, self.config.encoding, function(err){
		if(err){
			return callback(self.helpers.error('client_send', {Error: err}));
		}

		self.stats++;
		self.stat(data.message.headers.from, 'sent');
		self.stat(data.message.headers.to, 'received');

		self.emit('message', {
			id: clientMap[data.message.headers.to],
			message: data.message
		});
		return callback();
	});
}
// Public Methods

ricochetServer.prototype.listen = function(options, callback){
	var self = this;
	callback = callback || function(){};

	if(!this.authCallback){
		throw new ricochetServerError("No 'authCallback' callback method set.");
		return callback(self.helpers.error('server_nocallback'));
	}

	if(this.server){
		return callback(self.helpers.error('server_inuse'));
	}

	this.server = net.createServer();
	this.server.on('connection', function(client){
		return self.handleConnection(client);
	});
	// forward server events
	_.each(['error', 'listening'], function(event){
		self.server.on(event, function(data){
			return self.emit(event, data);
		});
	});
	return self.server.listen(options, callback);
}

ricochetServer.prototype.close = function(callback){
	var self = this;
	callback = callback || function(){};
	this.server.close(callback);
	_.each(this.clients, function(client, id){
		self.destroyClient(id);
	});
}


// Deprecated
ricochetServer.prototype.auth = function(callback){
	this.authCallback = callback;
}
ricochetServer.prototype.unrouted = function(callback){
	this.unroutedCallback = callback;
}


module.exports = ricochetServer;