import {
	randomBytes,
	createCipheriv,
	createDecipheriv,
	scryptSync,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { EncryptedCredential, VaultStore, CredentialMetadata } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

export class CredentialVault {
	private store: VaultStore;
	private derivedKey: Buffer;

	constructor(vaultKey: string, salt?: Buffer) {
		const useSalt = salt ?? randomBytes(SALT_LENGTH);
		this.derivedKey = scryptSync(vaultKey, useSalt, KEY_LENGTH) as Buffer;
		this.store = {
			version: 1,
			salt: useSalt.toString("hex"),
			credentials: {},
		};
	}

	set(name: string, value: string, opts?: { description?: string }): void {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, this.derivedKey, iv);

		let encrypted = cipher.update(value, "utf8", "hex");
		encrypted += cipher.final("hex");
		const tag = cipher.getAuthTag();

		const now = new Date().toISOString();
		const existing = this.store.credentials[name];

		this.store.credentials[name] = {
			iv: iv.toString("hex"),
			data: encrypted,
			tag: tag.toString("hex"),
			metadata: {
				name,
				description: opts?.description ?? existing?.metadata?.description,
				createdAt: existing?.metadata?.createdAt ?? now,
				updatedAt: now,
			},
		};
	}

	get(name: string): string {
		const credential = this.store.credentials[name];
		if (!credential) {
			throw new Error(`Credential not found: ${name}`);
		}

		const iv = Buffer.from(credential.iv, "hex");
		const tag = Buffer.from(credential.tag, "hex");
		const decipher = createDecipheriv(ALGORITHM, this.derivedKey, iv);
		decipher.setAuthTag(tag);

		let decrypted = decipher.update(credential.data, "hex", "utf8");
		decrypted += decipher.final("utf8");
		return decrypted;
	}

	has(name: string): boolean {
		return name in this.store.credentials;
	}

	delete(name: string): boolean {
		if (!(name in this.store.credentials)) {
			return false;
		}
		delete this.store.credentials[name];
		return true;
	}

	list(): CredentialMetadata[] {
		return Object.values(this.store.credentials).map((cred) => ({
			name: cred.metadata.name,
			description: cred.metadata.description,
			createdAt: cred.metadata.createdAt,
			updatedAt: cred.metadata.updatedAt,
		}));
	}

	save(filepath: string): void {
		writeFileSync(filepath, JSON.stringify(this.store, null, 2), "utf-8");
	}

	static load(filepath: string, vaultKey: string): CredentialVault {
		const raw = readFileSync(filepath, "utf-8");
		const data = JSON.parse(raw) as VaultStore;
		const salt = Buffer.from(data.salt, "hex");
		const vault = new CredentialVault(vaultKey, salt);
		vault.store = data;
		return vault;
	}
}
