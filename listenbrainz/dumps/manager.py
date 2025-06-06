""" This module contains a click group with commands to
create and import postgres data dumps.
"""
# listenbrainz-server - Server for the ListenBrainz project
#
# Copyright (C) 2017 MetaBrainz Foundation Inc.
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along
# with this program; if not, write to the Free Software Foundation, Inc.,
# 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import PurePath

import click
from flask import current_app

from listenbrainz.db.dump_entry import get_latest_incremental_dump, add_dump_entry, get_dump_entry, \
    get_previous_incremental_dump
from listenbrainz.dumps import DUMP_DEFAULT_THREAD_COUNT
from listenbrainz.dumps.check import check_ftp_dump_ages
from listenbrainz.dumps.cleanup import _cleanup_dumps
from listenbrainz.dumps.exporter import create_statistics_dump, dump_feedback_for_spark, dump_database, \
    create_sample_dump
from listenbrainz.dumps.importer import import_postgres_dump
from listenbrainz.dumps.mapping import create_mapping_dump
from listenbrainz.dumps.sample import import_sample_data
from listenbrainz.listenstore import LISTEN_MINIMUM_DATE
from listenbrainz.listenstore.dump_listenstore import DumpListenStore
from listenbrainz.utils import create_path
from listenbrainz.webserver import create_app

cli = click.Group()


@cli.command(name="create_mbcanonical")
@click.option('--location', '-l', default=os.path.join(os.getcwd(), 'listenbrainz-export'),
              help="path to the directory where the dump should be made")
@click.option("--use-lb-conn/--use-mb-conn", default=True, help="Dump the metadata table from the listenbrainz database")
def create_mbcanonical(location, use_lb_conn):
    """
    Create a dump of the canonical mapping tables. This includes the following items:

        - metadata for canonical recordings
        - canonical recording redirect
        - canonical release redirect

    These tables are created by the mapping `canonical-data` management command.

    - If canonical-data is called with --use-lb-conn then the canonical metadata and recording redirect tables will
      be in the listenbrainz timescale database connection
    - If called with --use-mb-conn then all tables will be in the musicbrainz database connection.
    - The canonical release redirect table will always be in the musicbrainz database connection.
    """
    app = create_app()
    with app.app_context():
        end_time = datetime.now()
        ts = end_time.strftime('%Y%m%d-%H%M%S')
        dump_name = 'musicbrainz-canonical-dump-{time}'.format(time=ts)
        dump_path = os.path.join(location, dump_name)
        create_path(dump_path)

        create_mapping_dump(dump_path, end_time, use_lb_conn)
        expected_num_dumps = 1

        try:
            write_hashes(dump_path)
        except IOError as e:
            current_app.logger.error('Unable to create hash files! Error: %s', str(e), exc_info=True)
            sys.exit(-1)

        try:
            # archive, md5, sha256 for each expected dump archive
            expected_num_dump_files = expected_num_dumps * 3
            if not sanity_check_dumps(dump_path, expected_num_dump_files):
                return sys.exit(-1)
        except OSError:
            sys.exit(-1)

        # Write the DUMP_ID file so that the FTP sync scripts can be more robust
        with open(os.path.join(dump_path, "DUMP_ID.txt"), "w") as f:
            # Mapping dump doesn't have a dump id (second field) as they are standalone
            f.write("%s 0 mbcanonical\n" % (ts, ))

        current_app.logger.info('Dumps created and hashes written at %s' % dump_path)


@cli.command(name="create_full")
@click.option('--location', '-l', default=os.path.join(os.getcwd(), 'listenbrainz-export'),
              help="path to the directory where the dump should be made")
@click.option('--location-private', '-lp', default=None,
              help="path to the directory where the private dumps should be made")
@click.option('--threads', '-t', type=int, default=DUMP_DEFAULT_THREAD_COUNT,
              help="the number of threads to be used while compression")
@click.option('--dump-id', type=int, default=None,
              help="the ID of the ListenBrainz data dump")
@click.option('--listen/--no-listen', 'do_listen_dump', default=True,
              help="If True, make a listens dump")
@click.option('--spark/--no-spark', 'do_spark_dump', type=bool, default=True,
              help="If True, make a spark listens dump")
@click.option('--db/--no-db', 'do_db_dump', type=bool, default=True,
              help="If True, make a public/private postgres dump")
@click.option('--timescale/--no-timescale', 'do_timescale_dump', type=bool, default=True,
              help="If True, make a public/private timescale dump")
@click.option('--stats/--no-stats', 'do_stats_dump', type=bool, default=True,
              help="If True, make a couchdb stats dump")
def create_full(location: str, location_private: str, threads: int, dump_id: int, do_listen_dump: bool,
                do_spark_dump: bool, do_db_dump: bool, do_timescale_dump: bool, do_stats_dump: bool):
    """ Create a ListenBrainz data dump which includes a private dump, a statistics dump
        and a dump of the actual listens from the listenstore.
    """
    app = create_app()
    with app.app_context():
        if not location_private and (do_db_dump or do_timescale_dump):
            current_app.logger.error("No location specified for creating private database and timescale dumps")
            sys.exit(-1)
        if location_private and os.path.normpath(location_private) == os.path.normpath(location):
            current_app.logger.error("Location specified for public and private dumps cannot be same")
            sys.exit(-1)
        if location_private and PurePath(location_private).is_relative_to(PurePath(location)):
            current_app.logger.error("Private dumps location cannot be a subdirectory of public dumps location")
            sys.exit(-1)
        ls = DumpListenStore(app)
        if dump_id is None:
            latest_inc_dump = get_latest_incremental_dump()
            if latest_inc_dump is not None:
                end_time = latest_inc_dump['created']
            else:
                end_time = datetime.now(tz=timezone.utc)
            dump_id = add_dump_entry(end_time, "full")
        else:
            dump_entry = get_dump_entry(dump_id, "full")
            if dump_entry is None:
                current_app.logger.error("No full dump with ID %d found", dump_id)
                sys.exit(-1)
            end_time = dump_entry['created']

        start_time = LISTEN_MINIMUM_DATE
        dump_name = f'listenbrainz-dump-{dump_id}-{end_time.strftime("%Y%m%d-%H%M%S")}-full'
        dump_path = os.path.join(location, dump_name)
        create_path(dump_path)

        private_dump_path = None
        if location_private:
            private_dump_path = os.path.join(location_private, dump_name)
            create_path(private_dump_path)

        locations = {
            "public": dump_path,
            "private": private_dump_path
        }

        expected_num_dumps = 0
        expected_num_private_dumps = 0
        if do_db_dump:
            dump_database("postgres", locations, end_time, threads)
            expected_num_dumps += 1
            expected_num_private_dumps += 1
        if do_timescale_dump:
            dump_database("timescale", locations, end_time, threads)
            expected_num_dumps += 1
            expected_num_private_dumps += 1
        if do_listen_dump:
            ls.dump_listens(
                dump_path, dump_id=dump_id, start_time=start_time,
                end_time=end_time, dump_type="full", threads=threads
            )
            expected_num_dumps += 1
        if do_spark_dump:
            ls.dump_listens_for_spark(dump_path, dump_id=dump_id, dump_type="full",
                                      start_time=start_time, end_time=end_time)
            expected_num_dumps += 1
        if do_stats_dump:
            create_statistics_dump(dump_path, end_time, threads)
            expected_num_dumps += 1

        try:
            write_hashes(dump_path)
            if private_dump_path:
                write_hashes(private_dump_path)
        except IOError as e:
            current_app.logger.error('Unable to create hash files! Error: %s', str(e), exc_info=True)
            sys.exit(-1)

        try:
            # 6 types of dumps, archive, md5, sha256 for each
            expected_num_dump_files = expected_num_dumps * 3
            expected_num_private_dumps = expected_num_private_dumps * 3
            if not sanity_check_dumps(dump_path, expected_num_dump_files):
                return sys.exit(-1)
            if private_dump_path and not sanity_check_dumps(private_dump_path, expected_num_private_dumps):
                return sys.exit(-1)
        except OSError:
            sys.exit(-1)

        current_app.logger.info('Dumps created and hashes written at %s' % dump_path)
        if private_dump_path:
            current_app.logger.info('Private dumps created and hashes written at %s' % private_dump_path)

        # Write the DUMP_ID file so that the FTP sync scripts can be more robust
        with open(os.path.join(dump_path, "DUMP_ID.txt"), "w") as f:
            f.write("%s %s full\n" % (end_time.strftime('%Y%m%d-%H%M%S'), dump_id))
        if private_dump_path:
            # Write the DUMP_ID file so that the backup sync scripts can be more robust
            with open(os.path.join(private_dump_path, "DUMP_ID.txt"), "w") as f:
                f.write("%s %s full\n" % (end_time.strftime('%Y%m%d-%H%M%S'), dump_id))

        if do_spark_dump:
            ls.cleanup_listen_delete_metadata()


@cli.command(name="create_incremental")
@click.option('--location', '-l', default=os.path.join(os.getcwd(), 'listenbrainz-export'))
@click.option('--threads', '-t', type=int, default=DUMP_DEFAULT_THREAD_COUNT)
@click.option('--dump-id', type=int, default=None)
def create_incremental(location, threads, dump_id):
    app = create_app()
    with app.app_context():
        ls = DumpListenStore(app)
        if dump_id is None:
            end_time = datetime.now(tz=timezone.utc)
            dump_id = add_dump_entry(end_time, "incremental")
        else:
            dump_entry = get_dump_entry(dump_id, "incremental")
            if dump_entry is None:
                current_app.logger.error("No incremental dump with ID %d found, exiting!", dump_id)
                sys.exit(-1)
            end_time = dump_entry['created']

        prev_dump_entry = get_previous_incremental_dump(dump_id)
        if prev_dump_entry is None:  # incremental dumps must have a previous dump in the series
            current_app.logger.error("Invalid dump ID %d, could not find previous incrmental dump", dump_id)
            sys.exit(-1)
        start_time = prev_dump_entry["created"]
        current_app.logger.info("Dumping data from %s to %s", start_time, end_time)

        dump_name = f'listenbrainz-dump-{dump_id}-{end_time.strftime("%Y%m%d-%H%M%S")}-incremental'
        dump_path = os.path.join(location, dump_name)
        create_path(dump_path)

        ls.dump_listens(dump_path, dump_id=dump_id, start_time=start_time, end_time=end_time,
                        dump_type="incremental", threads=threads)
        ls.dump_listens_for_spark(dump_path, dump_id=dump_id, dump_type="incremental",
                                  start_time=start_time, end_time=end_time)

        try:
            write_hashes(dump_path)
        except IOError as e:
            current_app.logger.error('Unable to create hash files! Error: %s', str(e), exc_info=True)
            sys.exit(-1)

        try:
            if not sanity_check_dumps(dump_path, 6):
                return sys.exit(-1)
        except OSError as e:
            sys.exit(-1)

        # Write the DUMP_ID file so that the FTP sync scripts can be more robust
        with open(os.path.join(dump_path, "DUMP_ID.txt"), "w") as f:
            f.write("%s %s incremental\n" % (end_time.strftime('%Y%m%d-%H%M%S'), dump_id))

        current_app.logger.info('Dumps created and hashes written at %s' % dump_path)


@cli.command(name="create_feedback")
@click.option('--location', '-l', default=os.path.join(os.getcwd(), 'listenbrainz-export'),
              help="path to the directory where the dump should be made")
@click.option('--threads', '-t', type=int, default=DUMP_DEFAULT_THREAD_COUNT,
              help="the number of threads to be used while compression")
def create_feedback(location, threads):
    """ Create a spark formatted dump of user/recommendation feedback data."""
    app = create_app()
    with app.app_context():

        end_time = datetime.now()
        ts = end_time.strftime('%Y%m%d-%H%M%S')
        dump_name = 'listenbrainz-feedback-{time}-full'.format(time=ts)
        dump_path = os.path.join(location, dump_name)
        create_path(dump_path)
        dump_feedback_for_spark(dump_path, end_time, threads)

        try:
            write_hashes(dump_path)
        except IOError as e:
            current_app.logger.error(
                'Unable to create hash files! Error: %s', str(e), exc_info=True)
            sys.exit(-1)

        try:
            if not sanity_check_dumps(dump_path, 3):
                sys.exit(-1)
        except OSError as e:
            sys.exit(-1)

        # Write the DUMP_ID file so that the FTP sync scripts can be more robust
        with open(os.path.join(dump_path, "DUMP_ID.txt"), "w") as f:
            f.write("%s 0 feedback\n" % (end_time.strftime('%Y%m%d-%H%M%S')))

        current_app.logger.info(
            'Feedback dump created and hashes written at %s' % dump_path)


@cli.command(name="create_sample")
@click.option('--location', '-l', default=os.path.join(os.getcwd(), 'listenbrainz-export'),
              help="path to the directory where the dump should be made")
@click.option('--threads', '-t', type=int, default=DUMP_DEFAULT_THREAD_COUNT,
              help="the number of threads to be used while compression")
def create_sample(location, threads):
    """ Create a sample data dump."""
    app = create_app()
    with app.app_context():

        end_time = datetime.now()
        ts = end_time.strftime('%Y%m%d-%H%M%S')
        dump_name = 'listenbrainz-sample-{time}-full'.format(time=ts)
        dump_path = os.path.join(location, dump_name)
        create_path(dump_path)
        create_sample_dump(dump_path, end_time, threads)

        try:
            write_hashes(dump_path)
        except IOError as e:
            current_app.logger.error(
                'Unable to create hash files! Error: %s', str(e), exc_info=True)
            sys.exit(-1)

        try:
            if not sanity_check_dumps(dump_path, 3):
                sys.exit(-1)
        except OSError as e:
            sys.exit(-1)

        # Write the DUMP_ID file so that the FTP sync scripts can be more robust
        with open(os.path.join(dump_path, "DUMP_ID.txt"), "w") as f:
            f.write("%s 0 sample\n" % (end_time.strftime('%Y%m%d-%H%M%S')))

        current_app.logger.info('Sample dump created and hashes written at %s' % dump_path)


@cli.command(name="import_dump")
@click.option('--private-archive', '-pr', default=None, required=False,
              help="the path to the ListenBrainz private dump to be imported")
@click.option('--private-timescale-archive', default=None, required=False,
              help="the path to the ListenBrainz private timescale dump to be imported")
@click.option('--public-archive', '-pu', default=None, required=False,
              help="the path to the ListenBrainz public dump to be imported")
@click.option('--public-timescale-archive', default=None, required=False,
              help="the path to the ListenBrainz public timescale dump to be imported")
@click.option('--listen-archive', '-l', default=None, required=False,
              help="the path to the ListenBrainz listen dump archive to be imported")
@click.option('--sample-archive', '-s', default=None, required=False,
              help="the path to the ListenBrainz sample dump archive to be imported")
@click.option('--threads', '-t', type=int, default=DUMP_DEFAULT_THREAD_COUNT,
              help="the number of threads to use during decompression, defaults to 1")
def import_dump(private_archive, private_timescale_archive,
                public_archive, public_timescale_archive,
                listen_archive, sample_archive, threads):
    """ Import a ListenBrainz dump into the database.

    Args:
        private_archive (str): the path to the ListenBrainz private dump to be imported
        private_timescale_archive (str): the path to the ListenBrainz private timescale dump to be imported
        public_archive (str): the path to the ListenBrainz public dump to be imported
        public_timescale_archive (str): the path to the ListenBrainz public timescale dump to be imported
        listen_archive (str): the path to the ListenBrainz listen dump archive to be imported
        sample_archive (str): the path to the ListenBrainz sample dump archive to be imported
        threads (int): the number of threads to use during decompression, defaults to 1

    .. note::
        This method tries to import the private db dump first, followed by the public db
        dump. However, in absence of a private dump, it imports sanitized versions of the user
        table in the public dump in order to satisfy foreign key constraints. Then it imports
        the listen dump.
    """
    app = create_app()
    with app.app_context():
        if private_archive or private_timescale_archive or public_archive or public_timescale_archive:
            import_postgres_dump(private_archive, private_timescale_archive,
                                 public_archive, public_timescale_archive,
                                 threads)

        if listen_archive:
            from listenbrainz.webserver.timescale_connection import _ts as ls
            ls.import_listens_dump(listen_archive, threads)

        if sample_archive:
            import_sample_data(sample_archive, threads)


@cli.command(name="delete_old_dumps")
@click.argument('location', type=str)
def delete_old_dumps(location):
    _cleanup_dumps(location)


@cli.command(name="check_dump_ages")
def check_dump_ages():
    """Check to make sure that data dumps are sufficiently fresh. Send mail if they are not."""
    check_ftp_dump_ages()


def write_hashes(location):
    """ Create hash files for each file in the given dump location

    Args:
        location (str): the path in which the dump archive files are present
    """
    for file in os.listdir(location):
        try:
            with open(os.path.join(location, '{}.md5'.format(file)), 'w') as f:
                md5sum = subprocess.check_output(
                    ['md5sum', os.path.join(location, file)]).decode('utf-8').split()[0]
                f.write(md5sum)
            with open(os.path.join(location, '{}.sha256'.format(file)), 'w') as f:
                sha256sum = subprocess.check_output(
                    ['sha256sum', os.path.join(location, file)]).decode('utf-8').split()[0]
                f.write(sha256sum)
        except OSError as e:
            current_app.logger.error(
                'IOError while trying to write hash files for file %s: %s', file, str(e), exc_info=True)
            raise


def sanity_check_dumps(location, expected_count):
    """ Sanity check the generated dumps to ensure that none are empty
        and make sure that the right number of dump files exist.

    Args:
        location (str): the path in which the dump archive files are present
        expected_count (int): the number of files that are expected to be present
    Return:
        boolean: true if the dump passes the sanity check
    """

    count = 0
    for file in os.listdir(location):
        try:
            dump_file = os.path.join(location, file)
            if os.path.getsize(dump_file) == 0:
                print("Dump file %s is empty!" % dump_file)
                return False
            count += 1
        except OSError as e:
            return False

    if expected_count == count:
        return True

    print("Expected %d dump files, found %d. Aborting." %
          (expected_count, count))
    return False
