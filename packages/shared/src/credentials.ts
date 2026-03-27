import { z } from "zod/v4";

export const credentialRefSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
});

export type CredentialRef = z.infer<typeof credentialRefSchema>;

export interface EncryptedCredential {
	iv: string;
	data: string;
	tag: string;
	metadata: {
		name: string;
		description?: string;
		createdAt: string;
		updatedAt: string;
	};
}

export interface VaultStore {
	version: 1;
	salt: string;
	credentials: Record<string, EncryptedCredential>;
}
