
import listenbrainz.db.user as db_user
import listenbrainz.db.spotify as db_spotify
import listenbrainz.db.listens_importer as db_import
import listenbrainz.db.external_service_oauth as db_oauth

import time

from data.model.external_service import ExternalServiceType
from listenbrainz.db import listens_importer
from listenbrainz.db.testing import DatabaseTestCase


class ListensImporterDatabaseTestCase(DatabaseTestCase):

    def setUp(self):
        super(ListensImporterDatabaseTestCase, self).setUp()
        self.user = db_user.get_or_create(self.db_conn, 1, 'testspotifyuser')
        db_oauth.save_token(
            self.db_conn,
            user_id=self.user['id'],
            service=ExternalServiceType.SPOTIFY,
            access_token='token',
            refresh_token='refresh_token',
            token_expires_ts=int(time.time()),
            record_listens=True,
            scopes=['user-read-recently-played']
        )

    def test_update_import_status(self):
        db_import.update_import_status(
            self.db_conn, self.user['id'], ExternalServiceType.SPOTIFY, 'test error message'
        )
        spotify_user = db_spotify.get_user_import_details(self.db_conn, self.user['id'])
        self.assertEqual(spotify_user['error_message'], 'test error message')
        self.assertIsNotNone(spotify_user['last_updated'])

        db_import.update_import_status(self.db_conn, self.user['id'], ExternalServiceType.SPOTIFY)
        spotify_user = db_spotify.get_user_import_details(self.db_conn, self.user['id'])
        self.assertIsNone(spotify_user['error_message'])
        self.assertIsNotNone(spotify_user['last_updated'])

    def test_update_latest_listened_at(self):
        spotify_user = db_spotify.get_user_import_details(self.db_conn, self.user['id'])
        self.assertIsNone(spotify_user['latest_listened_at'])
        self.assertIsNone(spotify_user['last_updated'])
        t = int(time.time())
        db_import.update_latest_listened_at(self.db_conn, self.user['id'], ExternalServiceType.SPOTIFY, t)
        spotify_user = db_spotify.get_user_import_details(self.db_conn, self.user['id'])
        self.assertEqual(t, int(spotify_user['latest_listened_at'].strftime('%s')))
        self.assertIsNotNone(spotify_user['last_updated'])

    def test_update_latest_import(self):
        user = db_user.get_or_create(self.db_conn, 3, 'updatelatestimportuser')

        val = int(time.time())
        listens_importer.update_latest_listened_at(self.db_conn, user['id'], ExternalServiceType.LASTFM, val)
        status = listens_importer.get_import_status(self.db_conn, user['id'], ExternalServiceType.LASTFM)
        self.assertEqual(status["latest_listened_at"], val)

        listens_importer.update_latest_listened_at(self.db_conn, user['id'], ExternalServiceType.LASTFM, 0)
        status = listens_importer.get_import_status(self.db_conn, user['id'], ExternalServiceType.LASTFM)
        self.assertEqual(status["latest_listened_at"], 0)
