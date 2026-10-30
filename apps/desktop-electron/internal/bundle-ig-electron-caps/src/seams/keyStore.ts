import { defineService } from '@nomi-ai/bundle-ig-base';

export interface KeyStoreService {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  del(id: string): Promise<void>;
  list(): Promise<string[]>;
}

export const KeyStoreKey = defineService<KeyStoreService>('ctx.keyStore');
