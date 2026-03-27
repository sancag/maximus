import { CredentialVault } from "./vault.js";

export interface CredentialInjection {
	ref: string;
	inject_as: string;
}

export class CredentialProxy {
	constructor(private vault: CredentialVault) {}

	async resolve(name: string): Promise<string> {
		return this.vault.get(name);
	}

	async resolveRefs(
		refs: CredentialInjection[],
	): Promise<Record<string, string>> {
		const resolved: Record<string, string> = {};
		for (const ref of refs) {
			resolved[ref.inject_as] = this.vault.get(ref.ref);
		}
		return resolved;
	}
}
