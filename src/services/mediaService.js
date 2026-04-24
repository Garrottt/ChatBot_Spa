const fs = require('fs/promises');
const path = require('path');

const { env } = require('../config/env');
const { AppError } = require('../lib/errors');
const { logger } = require('../lib/logger');

function createMediaService({ messageService, metaClient }) {
  async function persistIncomingMedia({ messageRecord, media }) {
    if (!messageRecord?.id || !media?.id) {
      return null;
    }

    const mediaUrl = buildMessageMediaUrl(messageRecord.id);
    const mergedMetadata = mergeMediaMetadata(messageRecord.metadata, {
      ...media,
      source: 'whatsapp_meta'
    });

    await messageService.updateMessage(messageRecord.id, {
      mediaUrl,
      metadata: mergedMetadata
    });

    try {
      const downloadedMedia = await metaClient.downloadMedia(media.id);
      const storage = await writeMediaFile({
        messageId: messageRecord.id,
        buffer: downloadedMedia.buffer,
        mimeType: downloadedMedia.mimeType || media.mimeType || null
      });

      await messageService.updateMessage(messageRecord.id, {
        mediaUrl,
        metadata: mergeMediaMetadata(mergedMetadata, {
          mimeType: downloadedMedia.mimeType || media.mimeType || null,
          sha256: downloadedMedia.sha256 || media.sha256 || null,
          sizeBytes: downloadedMedia.buffer.length,
          storagePath: storage.relativePath,
          storedAt: new Date().toISOString()
        })
      });
    } catch (error) {
      logger.warn('Unable to cache incoming media locally', {
        messageId: messageRecord.id,
        mediaId: media.id,
        error: error.message
      });
    }

    return { mediaUrl };
  }

  async function getMessageMedia(messageId) {
    const messageRecord = await messageService.findById(messageId);
    if (!messageRecord) {
      throw new AppError('No encontre el mensaje solicitado.', 404);
    }

    const mediaMetadata = getMediaMetadata(messageRecord);
    if (!mediaMetadata?.id && !mediaMetadata?.storagePath) {
      throw new AppError('El mensaje no tiene un archivo asociado.', 404);
    }

    const cached = await readCachedMedia(mediaMetadata);
    if (cached) {
      return cached;
    }

    if (!mediaMetadata?.id) {
      throw new AppError('No pude recuperar el archivo solicitado.', 404);
    }

    const downloadedMedia = await metaClient.downloadMedia(mediaMetadata.id);
    const storage = await writeMediaFile({
      messageId: messageRecord.id,
      buffer: downloadedMedia.buffer,
      mimeType: downloadedMedia.mimeType || mediaMetadata.mimeType || null
    });

    await messageService.updateMessage(messageRecord.id, {
      mediaUrl: messageRecord.mediaUrl || buildMessageMediaUrl(messageRecord.id),
      metadata: mergeMediaMetadata(messageRecord.metadata, {
        mimeType: downloadedMedia.mimeType || mediaMetadata.mimeType || null,
        sha256: downloadedMedia.sha256 || mediaMetadata.sha256 || null,
        sizeBytes: downloadedMedia.buffer.length,
        storagePath: storage.relativePath,
        storedAt: new Date().toISOString()
      })
    });

    return {
      buffer: downloadedMedia.buffer,
      mimeType: downloadedMedia.mimeType || mediaMetadata.mimeType || 'application/octet-stream'
    };
  }

  return {
    persistIncomingMedia,
    getMessageMedia
  };
}

module.exports = { createMediaService };

function buildMessageMediaUrl(messageId) {
  return `${String(env.appBaseUrl || '').replace(/\/$/, '')}/api/media/messages/${messageId}`;
}

function mergeMediaMetadata(existingMetadata, mediaPatch) {
  const metadata = existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {};
  const currentMedia = metadata.media && typeof metadata.media === 'object' ? metadata.media : {};

  return {
    ...metadata,
    media: {
      ...currentMedia,
      ...mediaPatch
    }
  };
}

function getMediaMetadata(messageRecord) {
  const metadata = messageRecord?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  return metadata.media && typeof metadata.media === 'object' ? metadata.media : null;
}

async function readCachedMedia(mediaMetadata) {
  if (!mediaMetadata?.storagePath) {
    return null;
  }

  const absolutePath = path.resolve(mediaMetadata.storagePath);

  try {
    const buffer = await fs.readFile(absolutePath);
    return {
      buffer,
      mimeType: mediaMetadata.mimeType || inferMimeTypeFromPath(absolutePath)
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  }
}

async function writeMediaFile({ messageId, buffer, mimeType }) {
  const extension = extensionFromMimeType(mimeType);
  const baseDir = path.resolve(env.mediaStorageDir || 'uploads/message-media');
  const fileName = `${messageId}${extension}`;
  const absolutePath = path.join(baseDir, fileName);

  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(absolutePath, buffer);

  return {
    fileName,
    absolutePath,
    relativePath: absolutePath
  };
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();

  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'application/pdf') return '.pdf';

  return '';
}

function inferMimeTypeFromPath(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();

  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.pdf') return 'application/pdf';

  return 'application/octet-stream';
}
