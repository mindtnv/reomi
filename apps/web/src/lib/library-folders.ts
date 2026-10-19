import { api, ok, ApiError } from './api';
import type { FolderNode } from '@reomi/shared';

export interface LibraryFolder extends FolderNode {
  revision: number;
  purpose: 'browser' | null;
  count: number;
  directCount: number;
}
export interface LibraryFolderList { items: LibraryFolder[]; unfiledCount: number; totalCount: number }

export const libraryFoldersApi = {
  async list(): Promise<LibraryFolderList> {
    const result = await ok(await api.library.folders.get());
    if (!Array.isArray(result.items)) throw new ApiError('invalid_folder_response', { status: 502 });
    return result;
  },
  async create(name: string, parentId: string | null) { return ok(await api.library.folders.post({ name, parentId })); },
  async update(id: string, body: { revision: number; name?: string; parentId?: string | null }) {
    return ok(await api.library.folders({ id }).patch(body));
  },
  async preview(id: string) { return ok(await api.library.folders({ id })['delete-preview'].get()); },
  async remove(id: string, confirmationToken: string, destinationId: string | null) {
    return ok(await api.library.folders({ id }).delete({ confirmationToken, destinationId }));
  },
  async moveItems(sourceIds: string[], folderId: string | null) {
    return ok(await api.library.folders['move-items'].post({ sourceIds, folderId }));
  },
  async browserDefault(name: string) { return ok(await api.library.folders['browser-default'].post({ name })); },
};
