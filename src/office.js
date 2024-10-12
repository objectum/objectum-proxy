/* eslint-disable no-whitespace-before-property */
/* eslint-disable eqeqeq */

import crypto from "crypto";
import nodemailer from "nodemailer";
import _ from "lodash";
import https from "https";

let smtp, transporter, role, roleId, secret, secretKey, disableRecaptchaCheck;

function initOffice (opts) {
	smtp = opts.smtp;
	role = opts.role;
	secret = opts.secret;
	secretKey = opts.secretKey;
	disableRecaptchaCheck = opts.disableRecaptchaCheck;
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

async function getRoleId({ store, role }) {
	let roleRecs = await store.getRecs ({
		model: "objectum.role"
	});
	roleId = _.find (roleRecs, {code: role});

	if (!roleId) {
		throw new Error ("Unknown role");
	}
	return roleId.id;
}

async function register ({activationHost, email, password, name, subject, text, recaptchaRes, store}) {
	if (!disableRecaptchaCheck) {
		let checkResult = await checkRecaptcha (recaptchaRes);

		if (!checkResult) {
			throw new Error ("Invalid recaptcha response");
		}
	}
	try {
		await store.rollbackTransaction ();
	} catch(err) {
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
		roleId = await getRoleId({ store, role })
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
		throw new Error ("No account");
	}
	await store.startTransaction ("account activation");

	let record = userRecords [0];
	record.login = record.email;

	await record.sync ();
	await store.commitTransaction ();

	return {login: record.login, password: record.password};
};

async function recoverRequest ({activationHost, email, name, password, subject, text, recaptchaRes, roleCode, store}) {
	if (!disableRecaptchaCheck) {
		let checkResult = await checkRecaptcha (recaptchaRes);

		if (!checkResult) {
			throw new Error ("Invalid recaptcha response");
		}
	}
	let filters = [
		["login", "=", email]
	]
	if (roleCode) {
		filters.push(['role', '=', await getRoleId({ store, role: roleCode })])
	}
	let userRecs = await store.getRecs ({
		model: "objectum.user",
		filters
	});
	let recoverId = crypto.createHash ("sha1").update (secret + email).digest ("hex").toUpperCase ();

	if (!userRecs.length) {
		let filters = [
			["login", "<>", recoverId],
			["email", "=", email]
		]
		if (roleCode) {
			filters.push(['role', '=', await getRoleId({ store, role: roleCode })])
		}
		userRecs = await store.getRecs ({
			model: "objectum.user",
			filters
		});
	}
	if (!userRecs.length) {
		throw new Error ("No account");
	}
	if (userRecs.length > 1) {
		throw new Error (`Account error, count: ${userRecs.length}`);
	}
	let url = `${activationHost}?email=${email}&recoverId=${recoverId}&newPassword=${password}`;

	if (roleCode) {
		url += `&roleCode=${roleCode}`
	}
	if (name) {
		url += `&newName=${name}`;
	}
	transporter = transporter || nodemailer.createTransport (smtp);

	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

	try {
		let info = await transporter.sendMail ({
			from: smtp.forceSender || smtp.sender,
			to: email,
			subject,
			text: `${text} ${url}`,
			html: `${text} <a href="${url}">${url}</a>`
		});
		console.log (`Message sent: ${info.messageId}`);

		return "a password recovery email has been sent to you";
	} catch (err) {
		throw new Error (err.message);
	}
}

async function recover ({email, recoverId, newPassword, newName, roleCode, store}) {
	let filters = [
		["login", "=", email]
	]
	if (roleCode) {
		filters.push(['role', '=', await getRoleId({ store, role: roleCode })])
	}
	let userRecords = await store.getRecords ({
		model: "objectum.user",
		filters
	});
	let secretId = crypto.createHash ("sha1").update (secret + email).digest ("hex").toUpperCase ();

	if (!userRecords.length) {
		let filters = [
			["login", "<>", secretId],
			["email", "=", email]
		]
		if (roleCode) {
			filters.push(['role', '=', await getRoleId({ store, role: roleCode })])
		}
		userRecords = await store.getRecords ({
			model: "objectum.user",
			filters
		});
	}
	if (!userRecords.length) {
		throw new Error ("No account");
	}
	if (userRecords.length > 1) {
		throw new Error (`Account error, count: ${userRecords.length}`);
	}
	if (secretId != recoverId) {
		throw new Error ("Invalid password recovery code");
	}
	await store.startTransaction ("password recovery");

	let record = userRecords [0];

	record.password = newPassword;

	if (newName) {
		record.name = newName;
	}
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
