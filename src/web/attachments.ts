export interface InputAttachment {
  name: string;
  data: string;
}

export const attachmentMaxBytes = 512 * 1024;
export const attachmentMaxCount = 4;
export const attachmentAccept =
  '.txt,.md,.csv,.json,.xml,.yaml,.yml,.ts,.tsx,.js,.py,.html,.css,.log,.png,.jpg,.jpeg,.webp';

export async function encodeAttachments(files: File[]): Promise<InputAttachment[]> {
  if (files.length > attachmentMaxCount) throw new Error('Attach at most 4 files.');
  if (files.reduce((total, file) => total + file.size, 0) > attachmentMaxBytes)
    throw new Error('Attachments must total 512 KiB or less.');
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { name: file.name, data: btoa(binary) };
    }),
  );
}
