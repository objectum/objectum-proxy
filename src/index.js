import _path from "path";
import http from "http";
import express from "express";
import expressProxy from "express-http-proxy";
import objectumClient from "objectum-client";
const {Store} = objectumClient;

export default class Proxy {
	constructor () {
		let me = this;
		
		me.registered = {};
		me.sessions = {};
		me.pool = {};
		me.progress = {};
	}
	
	async getStore (sid) {
		let me = this;
		
		if (!me.sessions [sid]) {
			throw new Error (`unknown session: ${sid}`);
		}
		let store = me.pool [sid];
		
		if (!store) {
			store = new Store ();
			
			store.setUrl (`http://${me.config.objectum.host}:${me.config.objectum.port}/projects/${me.config.database.db}/`);
			store.setSessionId (sid);
			Object.assign (store, me.sessions [sid]);
			
			if (me.map) {
				store.map = me.map;
				store.dict = me.dict;
			} else {
				await store.load ();
				
				store.informer ();
				
				me.map = store.map;
				me.dict = store.dict;
				me.store = store;
			}
			for (let path in me.registered) {
				store.register (path, me.registered [path]);
			}
			me.pool [sid] = store;
		}
		return store;
	}
	
	async execute (opts) {
		let me = this;
		
		try {
			let store = await me.getStore (opts.sid);
			
			opts.store = store;
			opts.progress = ({label, value, max}) => {
				me.progress [opts.sid] = me.progress [opts.sid] || {};
				
				if (label) {
					me.progress [opts.sid].label = label;
				}
				if (value) {
					me.progress [opts.sid].value = value;
				}
				if (max) {
					me.progress [opts.sid].max = max;
				}
			};
			if (opts.id) {
				let record = await store.getRecord (opts.id);
				
				if (typeof (record [opts._method]) != "function") {
					return {error: `unknown method: ${opts._method}`};
				}
				let result = await record [opts._method] (opts);
				
				delete me.progress [opts.sid];
				
				return {result};
			} else {
				let Model = store.registered [opts._model];
				
				if (!Model) {
					return {error: `model not registered: ${opts._model}`};
				}
				if (typeof (Model [opts._method]) != "function") {
					return {error: `unknown static method: ${opts._method}`};
				}
				let result = await Model [opts._method] (opts);
				
				delete me.progress [opts.sid];
				
				return {result};
			}
		} catch (err) {
			return {error: err.message, stack: err.stack.split ("\n")};
		}
	}
	
	getFilter ({fn, store, alias}) {
		return new Promise ((resolve, reject) => {
			let promise;
			
			try {
				promise = fn ({store, alias});
			} catch (err) {
				return reject (err);
			}
			if (promise && promise.then) {
				promise.then (filter => resolve (filter)).catch (err => reject (err));
			} else {
				resolve (promise);
			}
		});
	}
	
	async getModelFilter ({store, mid, alias}) {
		let me = this;
		let Model = store.registered [mid];
		
		if (Model) {
			let fn = Model._accessFilter;
			
			if (typeof (fn) == "function") {
				let filter = await me.getFilter ({fn, store, alias});
				
				if (filter && filter.length) {
					return filter;
				}
			}
		}
	}
	
	async getFilters (opts) {
		let me = this;
		let store = await me.getStore (opts.sid);
		let filters = [];
		
		if (opts.model) {
			let filter = await me.getModelFilter ({store, mid: opts.model, alias: "a"});
			
			if (filter && filter.length) {
				filters.push (filter);
			}
		}
		if (opts.query) {
			try {
				let query = store.getQuery (opts.query);
				let tokens = query.query.split ('{"model"');
				
				for (let i = 1; i < tokens.length; i ++) {
					let token = tokens [i];
					
					token = token.substr (0, token.indexOf ("}"));
					
					if (token) {
						let modelOpts = JSON.parse (`{"model"${token}}`);
						let filter = await me.getModelFilter ({store, mid: modelOpts.model, alias: modelOpts.alias});
						
						if (filter && filter.length) {
							filters.push (filter);
						}
					}
				}
			} catch (err) {
				throw new Error (`_accessFilter.query: ${opts.query}, error: ${err.message}`);
			}
		}
		return filters;
	}
	
	async api (request, response) {
		let me = this;
		let data;
		let query = request.url.split ("?")[1];
		
		request.on ("data", chunk => {
			if (data) {
				data = Buffer.concat ([data, chunk]);
			} else {
				data = chunk;
			}
		});
		request.on ("end", async () => {
			let json;
			
			try {
				json = JSON.parse (data);
			} catch (err) {
				return response.send ({error: err.message});
			}
			if (json._trace) {
				json._trace.push (["proxy-start", new Date ().getTime ()]);
				data = JSON.stringify (json);
			}
			if (json._model && json._method) {
				json.sid = request.query.sid;
				
				let result = await me.execute (json);
				
				return response.send (result);
			}
			if (json._fn == "getData") {
				json.sid = request.query.sid;
				
				try {
					let accessFilters = await me.getFilters (json);
					
					if (accessFilters && accessFilters.length) {
						json.accessFilters = accessFilters;
						data = JSON.stringify (json);
					}
				} catch (err) {
					console.error (err);
					return response.send ({error: err.message});
				}
			}
			if (json._fn == "getNews" && me.progress [request.query.sid]) {
				json.progress = 1;
				data = JSON.stringify (json);
			}
			let resData, reqErr;
			let req = http.request ({
				host: me.config.objectum.host,
				port: me.config.objectum.port,
				path: `/projects/${me.config.database.db}/${query ? `?${query}` : ""}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Content-Length": Buffer.byteLength (data, "utf8")
				}
			}, function (res) {
				res.setEncoding ("utf8");
				
				res.on ("data", function (d) {
					if (resData) {
						resData += d;
					} else {
						resData = d;
					}
				});
				res.on ("end", async () => {
					if (!reqErr) {
						if (json._fn == "auth") {
							let d = JSON.parse (resData);
							
							if (d.sessionId) {
								me.sessions [d.sessionId] = d;
								me.sessions [d.sessionId].username = json.username;
							}
						}
						if (json._trace) {
							let d = JSON.parse (resData);
							
							if (d._trace) {
								d._trace.push (["proxy-end", new Date ().getTime ()]);
								resData = JSON.stringify (d);
							}
						}
						if (json._fn == "getNews" && me.progress [request.query.sid]) {
							let d = JSON.parse (resData);
							
							d.progress = me.progress [request.query.sid];
							resData = JSON.stringify (d);
						}
						if ((json._rsc == "model" || json._rsc == "query") && (json._fn == "create" || json._fn == "set")) {
							await me.store.load ();
						}
						response.send (resData);
					}
				});
			});
			req.on ("error", function (err) {
				reqErr = err;
				response.send ({error: err.message});
			});
			req.end (data);
		});
	}
	
	proxyErrorHandler (err, res) {
		console.error (err.message);
		res.send ({error: err.message});
	}
	
	register (path, Cls) {
		this.registered [path] = Cls;
	}
	
	start ({config, path, __dirname}) {
		let me = this;
		
		me.config = config;
		
		me.app = express ();
		
		me.app.use (`${path}/public`, expressProxy (`http://${config.objectum.host}:${config.objectum.port}`, {
			parseReqBody: false,
			proxyReqPathResolver: function (req) {
				return `/public/${req.url}`;
			},
			proxyErrorHandler: me.proxyErrorHandler
		}));
		me.app.use (`${path}/upload`, expressProxy (`http://${config.objectum.host}:${config.objectum.port}`, {
			parseReqBody: false,
			proxyReqPathResolver: function (req) {
				return `/projects/${config.code}/upload${req.url}`;
			},
			proxyErrorHandler: me.proxyErrorHandler
		}));
		me.app.post (path, (req, res) => {
			me.api (req, res);
		});
		me.app.use (express.static (_path.join (__dirname, "build")));
		me.app.get ("/*", function (req, res) {
			res.sendFile (_path.join (__dirname, "build", "index.html"));
		});
		me.app.listen (config.port, function () {
			console.log (`server listening on port ${config.port}`);
		});
	}
};
