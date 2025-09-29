import time

from google.cloud import storage
from datetime import datetime, timedelta

from app.core import logger, settings
from app.core.errors import AppErrors


class StorageSDK:
    def __init__(self):
        self.client = storage.Client.from_service_account_json(settings.CREDENTIALS_PATH)
        self.bucket = self.client.bucket(bucket_name=settings.STORAGE_BUCKET_NAME)

    async def upload_image(self, image_bytes: bytes, user_id: str, image_type: str) -> dict[str, str]:
        try:
            timestamp_uid = int(time.time() * 1000)
            blob_path = f'users/{user_id}/images/{image_type}-{timestamp_uid}.png'
            blob = self.bucket.blob(blob_path)

            blob.upload_from_string(
                image_bytes,
                content_type='image/png',
                timeout=120
            )

            # generate signed url
            url = blob.generate_signed_url(
                version='v4',
                expiration=7 * 24 * 3600,
                method='GET'
            )

            return {
            'public': f'{settings.STORAGE_BUCKET_NAME}/{blob_path}',
            'access': url,
          }
        except Exception as e:
            raise AppErrors.SERVER_INTERNAL_ERROR(f"Error uploading image to storage: {str(e)}")

    def get_signed_url(self, public_url: str) -> str:
        """get signed url for file"""
        if not public_url:
            return ''
        try:
            # production environment
            file_path = public_url.split('/', 1)[1]  # remove bucket_name
            blob = self.bucket.blob(file_path)

            return blob.generate_signed_url(
                version='v4',
                expiration=7 * 24 * 3600,
                method='GET'
            )

        except Exception as e:
            logger.error(f"Sign URL error: {str(e)}")
            raise AppErrors.SERVER_INTERNAL_ERROR(f"Generate signed URL error: {str(e)}")
