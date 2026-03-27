import type { EncryptedCredential, VaultStore } from "@maximus/shared";
export type { EncryptedCredential, VaultStore };

export interface CredentialMetadata {
	name: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
}
