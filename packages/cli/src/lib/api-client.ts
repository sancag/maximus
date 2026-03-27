import { request } from "node:http";
import { getConfig } from "./config.js";

export function getBaseUrl(): string {
	const config = getConfig();
	return `http://127.0.0.1:${config.port}`;
}

export async function apiGet<T>(path: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const config = getConfig();
		const req = request(
			{ hostname: "127.0.0.1", port: config.port, path, method: "GET" },
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						reject(
							new Error(
								`Server returned ${res.statusCode}: ${data}`,
							),
						);
						return;
					}
					try {
						resolve(JSON.parse(data));
					} catch {
						reject(
							new Error(
								`Invalid JSON from server: ${data.slice(0, 100)}`,
							),
						);
					}
				});
			},
		);
		req.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
				reject(
					new Error(
						"Server not running. Run `maximus server start` first.",
					),
				);
			} else {
				reject(err);
			}
		});
		req.end();
	});
}

export async function apiPost<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
	return new Promise((resolve, reject) => {
		const config = getConfig();
		const payload = JSON.stringify(body);
		const req = request(
			{
				hostname: "127.0.0.1",
				port: config.port,
				path,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					if (res.statusCode && res.statusCode >= 400) {
						reject(new Error(`Server returned ${res.statusCode}: ${data}`));
						return;
					}
					try {
						resolve(JSON.parse(data));
					} catch {
						reject(new Error(`Invalid JSON from server: ${data.slice(0, 100)}`));
					}
				});
			},
		);
		req.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
				reject(new Error("Server not running. Run `maximus server start` first."));
			} else {
				reject(err);
			}
		});
		req.write(payload);
		req.end();
	});
}
