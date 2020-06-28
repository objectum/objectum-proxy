import _path from "path";
import http from "http";
import express from "express";
import expressProxy from "express-http-proxy";
import formidable from "formidable";
import objectumClient from "objectum-client";
import fs from "fs";
import util from "util";
import sharp from "sharp";
import office from "./office";
const {
	initOffice,
	register,
	activation,
	recoverRequest,
	recover
} = office;
const {Store, execute, factory} = objectumClient;
fs.renameAsync = util.promisify (fs.rename);
fs.unlinkAsync = util.promisify (fs.unlink);

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
		store.map.record = {};
		
		return store;
	}
	
	async execute (opts) {
		let me = this;
		
		try {
			let store = await me.getStore (opts.sid);
			
			if (opts._model == me.adminModel) {
				store = me.adminStore;
			}
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
			delete me.progress [opts.sid];
			
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
				console.error (err);
				throw new Error (`_accessFilter.query: ${opts.query}, error: ${err.message}, stack:  ${err.stack.split ("\n")}`);
			}
		}
		return filters;
	}
	
	async access ({data, resData, result, sid}) {
		let me = this;
		
		if (data._rsc != "record") {
			return true;
		}
		let store = await me.getStore (sid), model, id;
		
		if (store.username == "admin") {
			return true;
		}
		try {
			if (resData) {
/*
				if (data._fn == "get") {
					resData = JSON.parse (resData);
					model = store.getModel (resData._model);
					
					let record = factory ({rsc: "record", data: resData, store});
					
					if (me.Access && me.Access._accessRead) {
						if (!(await execute (me.Access._accessRead, {store, model, record}))) {
							return false;
						}
					}
					if (record._accessRead) {
						if (!(await execute (record._accessRead))) {
							return false;
						}
					}
				}
*/
				if (data._fn == "get" && me.Access && me.Access._accessRead) {
					resData = JSON.parse (resData);
					model = store.getModel (resData._model);
					
					let record = factory ({rsc: "record", data: resData, store});
					
					if (!(await execute (me.Access._accessRead, {store, model, record}))) {
						return false;
					}
				}
				if (data._fn == "getData" && me.Access && me.Access._accessDataAfter) {
					resData = JSON.parse (resData);
					
					let data = await execute (me.Access._accessDataAfter, {store, data: resData});
					
					if (typeof (data) === "boolean") {
						return data;
					}
					result.data = data;
					return true;
				}
			} else
			if (data._fn == "create") {
				model = store.getModel (data._model);
				
				if (!model) {
					return true;
				}
				let regModel = me.registered [model.getPath ()];
				
				if (me.Access && me.Access._accessCreate) {
					if (!(await execute (me.Access._accessCreate, {store, model, data}))) {
						return false;
					}
				}
				if (regModel && regModel._accessCreate) {
					if (!(await execute (regModel._accessCreate, {store, model, data}))) {
						return false;
					}
				}
			} else {
				let record = await store.getRecord (data.id);
				
				if (!record) {
					return true;
				}
				id = record.id;
				
				let model = store.getModel (record._model);
				
				if (data._fn == "set") {
					if (me.Access && me.Access._accessUpdate) {
						if (!(await execute (me.Access._accessUpdate, {store, model, record, data}))) {
							return false;
						}
					}
					if (record._accessUpdate) {
						if (!(await execute (record._accessUpdate))) {
							return false;
						}
					}
				}
				if (data._fn == "remove") {
					if (me.Access && me.Access._accessDelete) {
						if (!(await execute (me.Access._accessDelete, {store, model, record}))) {
							return false;
						}
					}
					if (record._accessDelete) {
						if (!(await execute (record._accessDelete))) {
							return false;
						}
					}
				}
			}
			return true;
			
		} catch (err) {
			throw new Error (`access function error: ${err.message},${model ? ` model: ${model.getPath ()},` : ""}${id ? ` record: ${id},` : ""} fn: ${data._fn}, stack: ${err.stack.split ("\\n")}`);
		}
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
				
				if (me.Access && me.Access._accessMethod) {
					let store = await me.getStore (request.query.sid);
					
					if (!(await execute (me.Access._accessMethod, {store, data: json}))) {
						return response.send ({error: "forbidden"});
					}
				}
				let result = await me.execute (json);
				
				return response.send (result);
			}
			if (json._fn == "getData") {
				if (me.Access && me.Access._accessData) {
					let store = await me.getStore (request.query.sid);
					
					if (!(await execute (me.Access._accessData, {store, data: json}))) {
						return response.send ({error: "forbidden"});
					}
				}
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
			if (json.hasOwnProperty ("_rsc") && json._rsc != "record") {
				let store = await me.getStore (request.query.sid);
				
				if (store.username != "admin") {
					return response.send ({error: "forbidden"});
				}
			}
			try {
				if (!(await me.access ({data: json, sid: request.query.sid}))) {
					return response.send ({error: "forbidden"});
				}
			} catch (err) {
				return response.send ({error: err.message});
			}
			if (me.progress [request.query.sid]) {
				if (json._fn == "startTransaction") {
					return response.send ({error: "action in progress"});
				}
				if (json._fn == "getNews") {
					json.progress = 1;
					data = JSON.stringify (json);
				}
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
/*
						if ((json._rsc == "model" || json._rsc == "query") && (json._fn == "create" || json._fn == "set")) {
							await me.store.load ();
						}
*/
						try {
							let result = {};
							
							if (await me.access ({data: json, resData, sid: request.query.sid, result})) {
								response.send (result.data || resData);
							} else {
								response.send ({error: "forbidden"});
							}
						} catch (err) {
							return response.send ({error: err.message});
						}
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
		if (Cls) {
			this.registered [path] = Cls;
		} else {
			this.Access = path;
		}
	}
	
	registerAccessMethods (methods) {
		this.Access = methods;
	}
	
	getOfficeMethods ({role, smtp, secret, secretKey}) {
		initOffice ({role, smtp, secret, secretKey});
		
		return {
			register,
			activation,
			recoverRequest,
			recover
		};
	}
	
	registerAdminMethods (methods, model = "admin") {
		this.adminModel = model;
		this.registered [this.adminModel] = methods;
	}
	
	async start ({config, path, __dirname, onInit}) {
		let me = this;
		
		me.config = config;
		
		me.app = express ();
		
		if (onInit) {
			onInit ({app: me.app});
		}
		me.app.use (`${path}/public`, expressProxy (`http://${config.objectum.host}:${config.objectum.port}`, {
			parseReqBody: false,
			proxyReqPathResolver: function (req) {
				return `/public/${req.url}`;
			},
			proxyErrorHandler: me.proxyErrorHandler
		}));
		me.app.post (`${path}/upload`, (req, res) => {
			const form = formidable ({
				uploadDir: `${__dirname}/public/files`
			});
			form.parse (req, async (err, fields, files) => {
				let name = fields.name;
				let path = files ["file"].path;
				let filename = `${__dirname}/public/files/${fields.objectId}-${fields.classAttrId}-${name}`;
				
				if (err) {
					return res.send ({error: err.message});
				}
				if (!name) {
					return res.send ({error: "upload error"});
				}
				try {
					let store = await me.getStore (req.query.sid || req.query.sessionId);
					let property = store.getProperty (fields.classAttrId);
					
					if (me.Access && me.Access._accessUpload) {
						if (!(await execute (me.Access._accessUpload, {
							store, path, property, recordId: fields.objectId
						}))) {
							throw new Error ("forbidden");
						};
					}
					let opts = property.getOpts ();
					
					if (opts.image) {
						let image = opts.image;
						
						if (image.resize) {
							if (image.resize.width && image.resize.height) {
								await sharp (path).resize (image.resize.width, image.resize.height).toFile (path);
							}
						}
						if (image.thumbnail) {
							let model = store.getModel (property.model);
							
							property = model.properties [image.thumbnail];

							if (!property) {
								throw new Error ("unknown thumbnail property: " + image.thumbnail);
							}
							opts = property.getOpts ();
							
							if (opts.image && opts.image.resize && opts.image.resize.width && opts.image.resize.height) {
								let tnPath = `${__dirname}/public/files/${fields.objectId}-${property.id}-${name}`;
								let record = await store.getRecord (fields.objectId);
								
								await sharp (path).resize (opts.image.resize.width, opts.image.resize.height).toFile (tnPath);
								
								record [image.thumbnail] = name;
								await record.sync ();
							}
						}
					}
					await fs.renameAsync (path, filename);
					
					res.send ({success: true});
				} catch (err) {
					try {
						await fs.unlinkAsync (path);
					} catch (err) {
					}
					res.send ({error: err.message});
				}
			});
		});
		me.app.post (path, (req, res) => {
			me.api (req, res);
		});
		me.app.use (express.static (_path.join (__dirname, "build")));
		me.app.get ("/files/*", function (req, res) {
			res.sendFile (`${__dirname}/public${decodeURI (req.url)}`);
		});
		me.app.get ("/*", function (req, res) {
			res.sendFile (_path.join (__dirname, "build", "index.html"));
		});
		// admin methods
		me.adminStore = new Store ();
		me.adminStore.setUrl (`http://${config.objectum.host}:${config.objectum.port}/projects/${config.database.db}/`);
		
		await me.adminStore.auth ({
			username: "admin",
			password: config.adminPassword
		});
		for (let path in me.registered) {
			me.adminStore.register (path, me.registered [path]);
		}
		if (me.Access && me.Access._init) {
			await execute (me.Access._init, {store: me.adminStore});
		}
		me.app.listen (config.port, function () {
			console.log (`server listening on port ${config.port}`);
		});
	}
};
