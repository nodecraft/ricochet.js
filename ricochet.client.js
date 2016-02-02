'use strict';

var net = require('net'),
	util = require('util');

var _ = require('lodash'),
	async = require('async'),
	eventEmitter2 = require('eventemitter2'),
	jsonStream = require('json-stream');

var ricochetClientError = require('./ricochet.error.js');

var ricochetClient = function(config){
	var self = this;

	this.options = null;
	this.config =_.defaults(config || {}, require('./ricochet.defaults.json'));

	this.currentMessage = {
		timeout: null,
		encrypted: true
	};

	this.status = {
		connected: false, // track connectino status
		auth: false,  // track authentication status
		activeConnection: true, // set to false to prevent reconnect
		channel: null, // track connected channel
		groups: [],
	};

	this.helpers = require('./ricochet.helpers.js')(this.config);

	this.buffer = ''; // input buffer from received packets
	this.msgs = {}; // map of messages and events tied to them
	this.socket = null; // TCP socket

	this.handles = new eventEmitter2.EventEmitter2(this.config.events);
	this.handles.on('message_nothandled', function(msg, handler){
		if(!handler){
			return; // ignore messages
		}
		handler.emit('error', self.helpers.error('message_nothandled'));
	});
	this.outbound = async.queue(function(data, cb){
		return self.sendMessage(data, function(err){
			if(err){
				self.emit('sendError', {
					Error: err.Error,
					code: err.code,
					message: data
				});
			}
			return cb(err);
		});
	}, this.config.queueSize);
	this.inbound = async.queue(function(data, cb){
		return self.receiveMessage(data, function(err){
			if(err){
				self.emit('receiveError', {
					Error: err.Error,
					code: err.code,
					message: data
				});
			}
			return cb(err);
		});
	}, this.config.queueSize);

	eventEmitter2.EventEmitter2.call(this);
};
util.inherits(ricochetClient, eventEmitter2.EventEmitter2);

// Private Methods

ricochetClient.prototype.createMsgID = function(){
	var code = this.helpers.generateCode();
	if(this.msgs[code] !== undefined){
		return this.createMsgID();
	}
	return code;
}
ricochetClient.prototype.cleanupMsg = function(id){
	if(this.msgs[id]){
		if(this.msgs[id].events){
			this.msgs[id].events.removeAllListeners();
			delete this.msgs[id].events;
		}
		if(this.msgs[id].timeout){
			clearTimeout(this.msgs[id].timeout);
			delete this.msgs[id].timeout;
		}
		delete this.msgs[id];
	}
}

ricochetClient.prototype.sendMessage = function(data, callback){
	var self = this;
	callback = callback || function(){};

	if(!self.status.connected || !self.socket){
		return callback(self.helpers.error('client_connection'));
	}
	if(!self.status.auth){
		if(this.helpers.has(data, ['publicKey', 'authKey', 'authStamp'])){
			self.emit('message', data);
			return this.socket.write(JSON.stringify(data) + self.config.delimiters.message, 'utf8', callback);
		}
		return callback(self.helpers.error('client_auth'));
	}

	var msg = {
		headers: {
			id: data.id || self.createMsgID(),
			to: data.to,
			type: data.type,
			handle: data.handle,
			encrypted: data.encrypted || true
		},
		body: data.body
	};

	if(data.encrypted){
		msg.body = self.helpers.encrypt(self.options.privateKey, JSON.stringify(msg.body), msg.headers.id);
	}
	switch(data.type){
		case "reply":
			msg.headers.status = data.status;
		break;
		case "request":
			var timeout = null;

			// garbage collection
			if(data.events){
				data.events.on('update', function(){
					if(timeout){
						clearTimeout(timeout);
						timeout = null;
					}
				});
				data.events.once('response', function(){
					self.cleanupMsg(msg.headers.id);
				});
				data.events.once('timeout', function(results){
					if(results.local === true){
						data.events.emit('error', self.helpers.error('message_timeout', results));
					}
				});
				data.events.once('error', function(results){
					if(results.code === 'message_timeout'){
						data.events.emit('timeout', {
							local: false
						});
					}
					self.cleanupMsg(msg.headers.id);
				});
			}

			if(data.timeout !== false && data.events){
				msg.headers.timeout = parseInt(data.timeout);
				if(isNaN(msg.headers.timeout)){
					msg.headers.timeout = self.config.timeouts.message;
				}
				timeout = setTimeout(function(){
					data.events.emit('timeout', {
						local: true
					});
				}, msg.headers.timeout + self.config.timeouts.latencyBuffer);
			}

			self.msgs[msg.headers.id] = {
				events: data.events || null,
				timeout: timeout
			};
		break;
	}

	return self.socket.write(JSON.stringify(msg) + self.config.delimiters.message, self.config.encoding, function(err){
		if(err){
			self.cleanupMsg(msg.headers.id); // cleanup
			return callback(self.helpers.error('client_send', {Error: err}));
		}
		return callback();
	});
}
ricochetClient.prototype.receiveMessage = function(msg, callback){
	var self = this;
	/*this.helpers.parseJSON(rawMsg, function(err, msg){
		if(err){
			return callback(self.helpers.error('message_badjson', {Error: err}));
		}*/
		if(!self.status.auth){
			if(typeof msg.auth == 'boolean'){
				self.status.auth = msg.auth;
				if(msg.auth && self.helpers.has(msg, ['channel', 'groups'])){
					self.status.channel = msg.channel;
					self.status.groups = msg.groups;
					self.emit('ready', {
						channel: msg.channel,
						groups: msg.groups
					});
				}else{
					self.emit('authFail', {
						message: msg
					});
					self.socket.end();
				}
				return callback();
			}
			return callback(self.helpers.error('message_auth'));
		}
		return self.parseMessage(msg, callback);
	//});
}
ricochetClient.prototype.parseMessage = function(msg, callback){
	var self = this;
	if(!this.helpers.has(msg, ['headers', 'body']) || !this.helpers.has(msg.headers, ['to', 'from', 'id', 'type'])){
		return callback(self.helpers.error('message_malformed'));
	}
	if(msg.headers.to != this.status.channel){
		return callback(self.helpers.error('message_channel'));
	}
	if(this.status.groups !== true && _.intersection(msg.headers.groups, this.status.groups).length === 0){
		return callback(self.helpers.error('message_group'));
	}
	if(msg.headers.encrypted){
		msg.body = self.helpers.parseJSON(self.helpers.decrypt(self.options.privateKey, msg.body));
		if(!msg.body){
			return callback(self.helpers.error('message_decrypt'));
		}
	}
	return this.handleMessage(msg, callback);
}
ricochetClient.prototype.handleMessage = function(msg, callback){
	var self = this;
	switch(msg.headers.type){
		case "message":
			if(!self.handles.emit(msg.headers.handle, msg.body, msg)){
				self.handles.emit('message_nothandled', msg);
			}
		break;
		case "request":
			var handler = self.replyHandler(msg);
			if(!self.handles.emit(msg.headers.handle, msg.body, handler, msg)){
				self.handles.emit('message_nothandled', msg, handler);
			}
		break;
		case "reply":
			if(!self.msgs[msg.headers.id]){
				return callback(self.helpers.error('message_notfound'));
			}
			if(!self.helpers.has(msg, 'headers.status')){
				return callback(self.helpers.error('message_malformed'));
			}
			if(self.msgs[msg.headers.id].events){
				if(msg.headers.status == 'response'){
					self.msgs[msg.headers.id].events.emit(msg.headers.status, msg.body.error, msg.body.data);
				}else{
					self.msgs[msg.headers.id].events.emit(msg.headers.status, msg.body);
				}
			}
		break;
	}
	return callback();
}
ricochetClient.prototype.replyHandler = function(msg, callback){
	var self = this,
		handler = new eventEmitter2.EventEmitter2();

	var timeout = null;
	if(msg.headers.timeout){
		timeout = setTimeout(function(){
			handler.emit('timeout');
		}, msg.headers.timeout);
	}
	handler.once('response', function(err, data){
		self.outbound.push({
			type: 'reply',
			status: 'response',
			encrypted: msg.headers.encrypted || true,
			id: msg.headers.id,
			to: msg.headers.from,
			handle: msg.headers.handle,
			body: {
				error: err,
				data: data || {}
			}
		});
		handler.emit('close');
	});
	handler.on('update', function(data){
		if(timeout){ // updates clear local timeout
			clearTimeout(timeout);
			timeout = null;
		}
		self.outbound.push({
			type: 'reply',
			status: 'update',
			encrypted: msg.headers.encrypted || true,
			id: msg.headers.id,
			to: msg.headers.from,
			handle: msg.headers.handle,
			body: data || {}
		});
	});
	handler.once('timeout', function(){
		self.outbound.push({
			type: 'reply',
			status: 'error',
			encrypted: msg.headers.encrypted || true,
			id: msg.headers.id,
			to: msg.headers.from,
			handle: msg.headers.handle,
			body: self.helpers.error('message_timeout')
		});
		handler.emit('close');
	});
	handler.once('error', function(data){
		self.outbound.push({
			type: 'reply',
			status: 'error',
			encrypted: msg.headers.encrypted || true,
			id: msg.headers.id,
			to: msg.headers.from,
			handle: msg.headers.handle,
			body: data
		});
		handler.emit('close');
	});
	handler.once('close', function(){
		if(timeout){
			clearTimeout(timeout);
			timeout = null;
		}
		handler.removeAllListeners();
		handler = null;
	});
	return handler;
}

ricochetClient.prototype.reset = function(){
	this.status.connected = false;
	this.status.auth = false;
	this.status.channel = null;
	this.status.groups = [];
}

ricochetClient.prototype.sendAuth = function(){
	if(this.status.auth){ return; }
	var self = this;

	var timestamp = self.helpers.encrypt(self.options.privateKey, new Date().getTime());

	self.outbound.push({
		publicKey: this.options.publicKey,
		authKey: self.helpers.encrypt(self.options.privateKey, self.options.authKey, timestamp),
		authStamp: timestamp
	});
}

// Public Methods

ricochetClient.prototype.connect = function(options, callback){
	var self = this;
	callback = callback || function(){};

	if(self.socket){
		return callback(self.helpers.error('client_connected'));
	}

	options =_.defaults(options || {}, {
		host: '127.0.0.1',
		port: 23225,
		authKey: '',
		publicKey: false,
		privateKey: false
	});
	if(!self.helpers.has(options, ['publicKey', 'privateKey'])){
		throw new ricochetClientError("Invalid options: 'publicKey' and 'privateKey' are required parameters.");
	}

	var firstConnect = false;
	if(!self.options){
		self.options = options;
		firstConnect = true;
	}

	self.socket = net.connect(self.options, function(){
		self.status.connected = true;
		if(firstConnect){
			self.emit('connected');
		}else{
			self.emit('reconnected');
		}
		// send authentication
		self.sendAuth();
		return callback();
	});
	self.socket.setNoDelay(options.noDelay || true);
	self.socket.setEncoding(this.config.encoding);

	var json = self.socket.pipe(jsonStream());

	json.on('data', function(data){
		self.emit('input', data);
		self.inbound.push(data);
		//self.buffer += String(data).trim();
		/*if(self.buffer.slice(-self.config.delimiters.message.length) === self.config.delimiters.message){
			var msgs = self.buffer.split(self.config.delimiters.message);
			self.buffer = msgs.splice(msgs.length-1); // return and slice last part (incomplete message)
			_.each(msgs, function(msg){
				self.inbound.push(msg);
			});
		}*/
	});
	self.socket.on('close', function(err){
		self.reset();
		self.socket = null;
		if(!self.status.activeConnection){
			return self.emit('close', err);
		}
		setTimeout(function(){
			self.connect();
		}, self.config.timeouts.reconnect);
		self.emit('disconnected', err);
	});

	// forward socket events
	_.each(['error', 'timeout', 'connect', 'drain', 'end', 'lookup'], function(event){
		self.socket.on(event, function(data){
			return self.emit(event, data);
		});
	});
}


ricochetClient.prototype.message = function(to, handle, data){
	this.outbound.push({
		type: 'message',
		to: to,
		handle: handle,
		body: data,
		encrypted: this.currentMessage.encrypted,
		timeout: this.currentMessage.timeout
	});
	this.currentMessage = {
		timeout: null,
		encrypted: true
	};
	return this;
};
ricochetClient.prototype.request = function(to, handle, data){
	var req = new eventEmitter2.EventEmitter2();
	this.outbound.push({
		type: 'request',
		events: req,
		to: to,
		handle: handle,
		body: data,
		encrypted: this.currentMessage.encrypted,
		timeout: this.currentMessage.timeout
	});
	this.currentMessage = {
		timeout: null,
		encrypted: true
	};
	return req;
};
ricochetClient.prototype.encrypt = function(set){
	set = set || true;
	this.currentMessage.encrypted = set;
	return this;
}
ricochetClient.prototype.insecure = function(){
	this.currentMessage.encrypted = false;
	return this;
}
ricochetClient.prototype.timeout = function(length){
	length = length || this.config.timeouts.message;
	this.currentMessage.timeout = length;
	return this;
}

ricochetClient.prototype.close = function(callback){
	callback = callback || function(){};
	this.status.activeConnection = false;
	return this.socket.end(callback)
}
ricochetClient.prototype.flushHandles = function(){
	return this.handles.removeAllListeners();
};

// Deprecated
ricochetClient.prototype.handle = function(handle, callback){
	return this.handles.on(handle, callback);
};
ricochetClient.prototype.notHandled = function(callback){
	this.handles.removeAllListeners('message_nothandled');
	return this.handles.on('message_nothandled', callback);
};


module.exports = ricochetClient;