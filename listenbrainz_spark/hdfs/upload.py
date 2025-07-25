import logging
import os
import shutil
import tarfile
import tempfile
import time
from pathlib import Path
from tarfile import TarFile

from listenbrainz_spark.exceptions import DumpInvalidException
from listenbrainz_spark.hdfs.utils import delete_dir, path_exists, upload_to_HDFS
from listenbrainz_spark.path import ARTIST_COUNTRY_CODE_DATAFRAME, RECORDING_ARTIST_DATAFRAME, \
    RECORDING_FEEDBACK_DATAFRAME, RELEASE_GROUP_METADATA_CACHE_DATAFRAME, ARTIST_CREDIT_MBID_DATAFRAME, \
    RECORDING_LENGTH_DATAFRAME, RECORDING_RECORDING_TAG_DATAFRAME, RECORDING_ARTIST_TAG_DATAFRAME, \
    RECORDING_RELEASE_GROUP_TAG_DATAFRAME, RECORDING_RELEASE_GROUP_GENRE_DATAFRAME, RECORDING_ARTIST_GENRE_DATAFRAME, \
    RECORDING_RECORDING_GENRE_DATAFRAME, RELEASE_METADATA_CACHE_DATAFRAME

logger = logging.getLogger(__name__)

HDFS_TEMP_DIR = "/temp"


def extract_and_upload_archive(archive, local_dir, hdfs_dir, extension, cleanup_on_failure=True):
    """
    Extract the archive and upload it to the given hdfs directory.
    Args:
        archive: path to the tar archive to uploaded
        local_dir: path to local dir to be used for extraction
        hdfs_dir: path to hdfs dir where contents of tar should be uploaded
        extension: the file extension members to upload
        cleanup_on_failure: whether to delete local and hdfs directories
            if error occurs during extraction
    """
    total_files = 0
    total_time = 0.0
    with tarfile.open(archive, mode="r") as tar:
        for member in tar:
            if member.isfile() and member.name.endswith(extension):
                logger.info(f"Uploading {member.name}...")
                t0 = time.monotonic()

                try:
                    tar.extract(member, path=local_dir)
                except tarfile.TarError as err:
                    if cleanup_on_failure:
                        if path_exists(hdfs_dir):
                            delete_dir(hdfs_dir, recursive=True)
                        shutil.rmtree(local_dir, ignore_errors=True)
                    raise DumpInvalidException(f"{type(err).__name__} while extracting {member.name}, aborting import") \
                        from err

                hdfs_path = os.path.join(hdfs_dir, member.name)
                local_path = os.path.join(local_dir, member.name)
                upload_to_HDFS(hdfs_path, local_path)

                time_taken = time.monotonic() - t0
                total_files += 1
                total_time += time_taken
                logger.info(f"Done! Current file processed in {time_taken:.2f} sec")

    if total_files == 0:
        logger.info("Done! No files processed.")
    else:
        logger.info(f"Done! Total files processed {total_files}. Average time taken: {total_time / total_files:.2f}")


def upload_archive_to_hdfs_temp(archive: str, extension: str) -> str:
    """ Upload parquet files in archive to a temporary hdfs directory

        Args:
            archive: the archive to be uploaded
            extension: the file extension members to upload
        Returns:
            path of the temp dir where archive has been uploaded
        Notes:
            The following dump structure should be ensured for this
            function to work correctly. Say, the dump is named
            v-2021-08-15.tar. The tar should contain one top level
            directory, v-2021-08-15. This directory should contain
            all the files that need to be uploaded.
    """
    with tempfile.TemporaryDirectory() as local_temp_dir:
        logger.info("Cleaning HDFS temporary directory...")
        if path_exists(HDFS_TEMP_DIR):
            delete_dir(HDFS_TEMP_DIR, recursive=True)

        logger.info("Uploading listens to temporary directory in HDFS...")
        extract_and_upload_archive(archive, local_temp_dir, HDFS_TEMP_DIR, extension)

    # dump is uploaded to HDFS_TEMP_DIR/archive_name
    archive_name = Path(archive).stem
    return str(Path(HDFS_TEMP_DIR).joinpath(archive_name))


def upload_sample_dump(tar: TarFile, local_dir):
    SAMPLE_TO_HDFS_MAP = {
        "artist_country_code": ARTIST_COUNTRY_CODE_DATAFRAME,
        "recording_length": RECORDING_LENGTH_DATAFRAME,
        "recording_artist": RECORDING_ARTIST_DATAFRAME,
        "release_group_metadata": RELEASE_GROUP_METADATA_CACHE_DATAFRAME,
        "release_metadata": RELEASE_METADATA_CACHE_DATAFRAME,
        "artist_credit": ARTIST_CREDIT_MBID_DATAFRAME,
        "recording_feedback": RECORDING_FEEDBACK_DATAFRAME,
        "recording_tag": RECORDING_RECORDING_TAG_DATAFRAME,
        "artist_tag": RECORDING_ARTIST_TAG_DATAFRAME,
        "release_group_tag": RECORDING_RELEASE_GROUP_TAG_DATAFRAME,
        "recording_genre": RECORDING_RECORDING_GENRE_DATAFRAME,
        "artist_genre": RECORDING_ARTIST_GENRE_DATAFRAME,
        "release_group_genre": RECORDING_RELEASE_GROUP_GENRE_DATAFRAME,
    }

    total_files = 0
    total_time = 0.0

    for member in tar:
        if member.isfile() and "spark" in member.name and member.name.endswith(".parquet"):
            logger.info(f"Uploading {member.name}...")
            t0 = time.monotonic()

            tar.extract(member, path=local_dir)
            local_path = os.path.join(local_dir, member.name)

            cache_name = member.name.split("/")[-1].split(".")[0]
            hdfs_path = SAMPLE_TO_HDFS_MAP[cache_name]

            upload_to_HDFS(hdfs_path, local_path)

            time_taken = time.monotonic() - t0
            total_files += 1
            total_time += time_taken
            logger.info(f"Done! Current file processed in {time_taken:.2f} sec")

    if total_files == 0:
        logger.info("Done! No files processed.")
    else:
        logger.info(f"Done! Total files processed {total_files}. Average time taken: {total_time / total_files:.2f}")
