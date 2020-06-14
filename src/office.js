/* eslint-disable no-whitespace-before-property */
/* eslint-disable eqeqeq */

import crypto from "crypto";
import nodemailer from "nodemailer";
import _ from "lodash";
import https from "https";

let smtp, transporter, role, roleId, secret, secretKey;

function initOffice (opts) {
	smtp = opts.smtp;
	role = opts.role;
	secret = opts.secret;
	secretKey = opts.secretKey;
};

function checkRecaptcha (response) {
	let resData, reqErr;
	
	return new Promise ((resolve, reject) => {
		let req = https.request ({
			host: "www.google.com",
			port: 443,
			path: `/recaptcha/api/siteverify?secret=${secretKey}&response=${response}`,
			method: "GET"
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
					resData = JSON.parse (resData);
					resolve (resData.success);
				}
			});
		});
		req.on ("error", function (err) {
			reqErr = err;
			reject (err);
		});
		req.end ();
	});
};

async function register ({activationHost, email, password, name, subject, text, recaptchaRes, store}) {
	let checkResult = await checkRecaptcha (recaptchaRes);
	
	if (!checkResult) {
		throw new Error ("Invalid recaptcha response");
	}
	let userRecs = await store.getRecs ({
		model: "objectum.user",
		filters: [
			["login", "=", email]
		]
	});
	if (userRecs.length) {
		throw new Error ("Account already exists");
	}
	if (!roleId) {
		let roleRecs = await store.getRecs ({
			model: "objectum.role"
		});
		roleId = _.find (roleRecs, {code: role});
		
		if (!roleId) {
			throw new Error ("Unknown role");
		}
		roleId = roleId.id;
	}
	let activationId = crypto.createHash ("sha1").update (secret + email).digest ("hex").toUpperCase ();
	
	userRecs = await store.getRecs ({
		model: "objectum.user",
		filters: [
			["login", "=", activationId]
		]
	});
	if (!userRecs.length) {
		await store.startTransaction (`user registering: ${email}`);
		await store.createRecord ({
			_model: "objectum.user",
			name,
			email,
			login: activationId,
			password,
			role: roleId
		});
		await store.commitTransaction ();
	}
	transporter = transporter || nodemailer.createTransport (smtp);
	
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	
	let url = `${activationHost}?activationId=${activationId}`;
	
	try {
		let info = await transporter.sendMail ({
			from: smtp.forceSender || smtp.sender,
			to: email,
			subject,
			text: `${text} ${url}`,
			html: `${text} <a href="${url}">${url}</a>`
		});
		console.log (`Message sent: ${info.messageId}`);
		
		return "email has been sent to you with instructions to activate your account";
	} catch (err) {
		throw new Error (err.message);
	}
}

async function activation ({store, activationId}) {
	let userRecords = await store.getRecords ({
		model: "objectum.user",
		filters: [
			["login", "=", activationId]
		]
	});
	if (!userRecords.length) {
		throw new Error ("no account");
	}
	await store.startTransaction ("account activation");
	
	let record = userRecords [0];
	record.login = record.email;
	
	await record.sync ();
	await store.commitTransaction ();
	
	return {login: record.login, password: record.password};
};

async function recoverRequest ({activationHost, email, password, recaptchaRes, store}) {
	let checkResult = await checkRecaptcha (recaptchaRes);
	
	if (!checkResult) {
		throw new Error ("Invalid recaptcha response");
	}
	let userRecs = await store.getRecs ({
		model: "objectum.user",
		filters: [
			["login", "=", email]
		]
	});
	if (!userRecs.length) {
		throw new Error ("no account");
	}
	let recoverId = crypto.createHash ("sha1").update (secret + email).digest ("hex").toUpperCase ();
	let url = `${activationHost}?email=${email}&recoverId=${recoverId}&newPassword=${password}`;
	
	transporter = transporter || nodemailer.createTransport (smtp);
	
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	
	try {
		let info = await transporter.sendMail ({
			from: smtp.forceSender || smtp.sender,
			to: email,
			subject: "Восстановление пароля пользователя в 'Навигатор в мире дошкольного образования'",
			text: `${text} ${url}`,
			html: `${text} <a href="${url}">${url}</a>`
		});
		console.log (`Message sent: ${info.messageId}`);
		
		return "a password recovery email has been sent to you";
	} catch (err) {
		throw new Error (err.message);
	}
}

async function recover ({email, recoverId, newPassword, store}) {
	let userRecords = await store.getRecords ({
		model: "objectum.user",
		filters: [
			["login", "=", email]
		]
	});
	if (!userRecords.length) {
		throw new Error ("no account");
	}
	let secretId = crypto.createHash ("sha1").update ("secret" + email).digest ("hex").toUpperCase ();
	
	if (secretId != recoverId) {
		throw new Error ("Invalid password recovery code");
	}
	await store.startTransaction ("password recovery");
	
	let record = userRecords [0];
	
	record.password = newPassword;
	
	await record.sync ();
	await store.commitTransaction ();
	
	return {login: record.login};
}

export default {
	initOffice,
	register,
	activation,
	recoverRequest,
	recover
};
