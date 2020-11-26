/* eslint-disable jsx-a11y/anchor-is-valid,camelcase */

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as _ from "lodash";
import * as io from "socket.io-client";

import { ActionMeta, ValueType } from "react-select";
import {
  faEllipsisV,
  faPen,
  faPlusCircle,
  faTrashAlt,
} from "@fortawesome/free-solid-svg-icons";

import { AlertList } from "react-bs-notifier";
import AsyncSelect from "react-select/async";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { IconProp } from "@fortawesome/fontawesome-svg-core";
import { ReactSortable } from "react-sortablejs";
import debounceAsync from "debounce-async";
import APIService from "../APIService";
import BrainzPlayer from "../BrainzPlayer";
import Card from "../components/Card";
import CreateOrEditPlaylistModal from "./CreateOrEditPlaylistModal";
import DeletePlaylistConfirmationModal from "./DeletePlaylistConfirmationModal";
import ErrorBoundary from "../ErrorBoundary";
import PlaylistItemCard from "./PlaylistItemCard";

export interface PlaylistPageProps {
  apiUrl: string;
  playlist: ListenBrainzPlaylist;
  spotify: SpotifyUser;
  currentUser?: ListenBrainzUser;
  webSocketsServerUrl: string;
}

export interface PlaylistPageState {
  alerts: Array<Alert>;
  currentTrack?: ListenBrainzTrack;
  playlist: ListenBrainzPlaylist;
  recordingFeedbackMap: RecordingFeedbackMap;
  trackMetadataMap: RecordingMetadataMap;
}

type OptionType = { label: string; value: ACRMSearchResult };

const PLAYLIST_TRACK_URI_PREFIX = "https://musicbrainz.org/recording/";

export default class PlaylistPage extends React.Component<
  PlaylistPageProps,
  PlaylistPageState
> {
  static getRecordingMBIDFromJSPFTrack(track: JSPFTrack): string {
    return track.identifier?.[0].substr(PLAYLIST_TRACK_URI_PREFIX.length) ?? "";
  }

  static makeJSPFTrack(track: ACRMSearchResult): JSPFTrack {
    return {
      identifier: [`${PLAYLIST_TRACK_URI_PREFIX}${track.recording_mbid}`],
      title: track.recording_name,
      creator: track.artist_credit_name,
    };
  }

  private APIService: APIService;
  private searchForTrackDebounced: any;
  private brainzPlayer = React.createRef<BrainzPlayer>();

  private socket!: SocketIOClient.Socket;

  constructor(props: PlaylistPageProps) {
    super(props);
    this.state = {
      alerts: [],
      playlist: props.playlist || [],
      recordingFeedbackMap: {},
      trackMetadataMap: {},
    };

    this.APIService = new APIService(
      props.apiUrl || `${window.location.origin}/1`
    );

    this.searchForTrackDebounced = debounceAsync(this.searchForTrack, 500, {
      leading: false,
    });
  }

  componentDidMount(): void {
    const { currentUser } = this.props;
    this.connectWebsockets();
    // Is this correct? When do we want to load feedback? always?
    // if (currentUser?.name === user?.name) {
    this.loadFeedback();
    // }
  }

  connectWebsockets = (): void => {
    // Do we want to show live updates for everyone, or just owner & collaborators?
    this.createWebsocketsConnection();
    this.addWebsocketsHandlers();
  };

  createWebsocketsConnection = (): void => {
    const { webSocketsServerUrl } = this.props;
    this.socket = io.connect(webSocketsServerUrl);
  };

  addWebsocketsHandlers = (): void => {
    // this.socket.on("connect", () => {
    // });
    this.socket.on("playlist_change", (data: string) => {
      this.handlePlaylistChange(data);
    });
  };

  handlePlaylistChange = (data: string): void => {
    const newPlaylist = JSON.parse(data);
    // rerun fetching metadata for all tracks?
    // or find new tracks and fetch metadata for them, add them to local Map
    this.setState((prevState) => {
      const { playlist } = prevState;
      // Respond to each atomic change received here.
      // Can be of type add, delete, move, playlist attributes change
      return { playlist };
    });
  };

  playTrack = (track: ListenBrainzTrack): void => {
    const listen: Listen = {
      listened_at: 0,
      track_metadata: {
        artist_name: track.creator,
        track_name: track.title,
        release_name: track.album,
        additional_info: {
          duration_ms: track.duration,
          recording_mbid: track.id,
          origin_url: track.location?.[0],
        },
      },
    };
    if (this.brainzPlayer.current) {
      this.brainzPlayer.current.playListen(listen);
    }
  };

  addTrack = async (
    track: ValueType<OptionType>,
    actionMeta: ActionMeta<OptionType>
  ): Promise<void> => {
    if (actionMeta.action === "select-option") {
      if (!track) {
        return;
      }
      const { label, value } = track as OptionType;
      const { currentUser, playlist } = this.props;
      if (!currentUser?.auth_token) {
        this.alertMustBeLoggedIn();
        return;
      }
      try {
        await this.APIService.addPlaylistItems(
          currentUser.auth_token,
          playlist.id,
          [PlaylistPage.makeJSPFTrack(value)]
        );
        this.newAlert("success", "Added track", `Added track ${label}`);
      } catch (error) {
        this.newAlert("danger", "Error", error.message);
      }
    }
  };

  searchForTrack = async (inputValue: string): Promise<OptionType[]> => {
    try {
      const response = await fetch(
        "https://datasets.listenbrainz.org/acrm-search/json",
        {
          method: "POST",
          body: JSON.stringify([{ query: inputValue }]),
          headers: {
            "Content-type": "application/json; charset=UTF-8",
          },
        }
      );
      // Converting to JSON
      const parsedResponse: ACRMSearchResult[] = await response.json();
      // Format the received items to a react-select option
      return parsedResponse.map((hit: ACRMSearchResult) => ({
        label: `${hit.recording_name} — ${hit.artist_credit_name}`,
        value: hit,
      }));
    } catch (error) {
      console.debug(error);
    }
    return [];
  };

  copyPlaylist = async (): Promise<void> => {
    const { currentUser } = this.props;
    const { playlist } = this.state;
    if (!currentUser?.auth_token) {
      this.alertMustBeLoggedIn();
      return;
    }
    try {
      await this.APIService.createPlaylist(
        currentUser.auth_token,
        playlist.title,
        playlist.track,
        playlist.public,
        playlist.annotation
      );
      this.newAlert(
        "success",
        "Copied playlist",
        `Copied playlist ${playlist.id}`
      );
    } catch (error) {
      this.newAlert("danger", "Error", error.message);
    }
  };

  deletePlaylist = async (): Promise<void> => {
    const { currentUser } = this.props;
    const { playlist } = this.state;
    if (!currentUser?.auth_token) {
      this.alertMustBeLoggedIn();
      return;
    }
    try {
      await this.APIService.deletePlaylist(currentUser.auth_token, playlist.id);
      // redirect
      this.newAlert(
        "success",
        "Deleted playlist",
        `Deleted playlist ${playlist.title}`
      );
      // Wait 1.5 second before navigating to user playlists page
      await new Promise((resolve) => {
        setTimeout(resolve, 1500);
      });
      window.location.href = `${window.location.origin}/user/${currentUser.name}/playlists`;
    } catch (error) {
      this.newAlert("danger", "Error", error.message);
    }
  };

  handleCurrentTrackChange = (track: ListenBrainzTrack | Listen): void => {
    this.setState({ currentTrack: track as ListenBrainzTrack });
  };

  isCurrentTrack = (track: ListenBrainzTrack): boolean => {
    const { currentTrack } = this.state;
    return Boolean(currentTrack && _.isEqual(track, currentTrack));
  };

  newAlert = (
    type: AlertType,
    title: string,
    message?: string | JSX.Element
  ): void => {
    const newAlert = {
      id: new Date().getTime(),
      type,
      title,
      message,
    } as Alert;

    this.setState((prevState) => {
      return {
        alerts: [...prevState.alerts, newAlert],
      };
    });
  };

  onAlertDismissed = (alert: Alert): void => {
    const { alerts } = this.state;

    // find the index of the alert that was dismissed
    const idx = alerts.indexOf(alert);

    if (idx >= 0) {
      this.setState({
        // remove the alert from the array
        alerts: [...alerts.slice(0, idx), ...alerts.slice(idx + 1)],
      });
    }
  };

  getFeedback = async () => {
    const { currentUser, playlist } = this.props;
    const { track: tracks } = playlist;
    if (tracks) {
      const recordings = tracks.map(PlaylistPage.getRecordingMBIDFromJSPFTrack);
      try {
        const data = await this.APIService.getFeedbackForUserForRecordings(
          currentUser.name,
          recordings.join(", ")
        );
        return data.feedback;
      } catch (error) {
        this.newAlert(
          "danger",
          "Playback error",
          typeof error === "object" ? error.message : error
        );
      }
    }
    return [];
  };

  loadFeedback = async () => {
    const feedback = await this.getFeedback();
    const recordingFeedbackMap: RecordingFeedbackMap = {};
    feedback.forEach((fb: FeedbackResponse) => {
      recordingFeedbackMap[fb.recording_msid] = fb.score;
    });
    this.setState({ recordingFeedbackMap });
  };

  updateFeedback = (recordingMsid: string, score: ListenFeedBack) => {
    const { recordingFeedbackMap } = this.state;
    recordingFeedbackMap[recordingMsid] = score;
    this.setState({ recordingFeedbackMap });
  };

  getFeedbackForRecordingMbid = (
    recordingMbid?: string | null
  ): ListenFeedBack => {
    const { recordingFeedbackMap } = this.state;
    return recordingMbid ? _.get(recordingFeedbackMap, recordingMbid, 0) : 0;
  };

  hasRightToEdit = (): boolean => {
    const { currentUser } = this.props;
    const { playlist } = this.state;
    const { creator, collaborators } = playlist;
    if (
      currentUser?.name === creator ||
      (collaborators ?? []).findIndex(
        (collaborator) => collaborator === currentUser?.name
      ) >= 0
    ) {
      return true;
    }
    return false;
  };

  deletePlaylistItem = async (trackToDelete: ListenBrainzTrack) => {
    const { currentUser } = this.props;
    const { playlist } = this.state;
    const { track: tracks } = playlist;
    if (!currentUser?.auth_token) {
      this.alertMustBeLoggedIn();
      return;
    }
    if (!this.hasRightToEdit()) {
      this.newAlert(
        "danger",
        "Not allowed",
        "You are not authorized to modify this playlist"
      );
      return;
    }
    const recordingMBID = PlaylistPage.getRecordingMBIDFromJSPFTrack(
      trackToDelete
    );
    const trackIndex = _.findIndex(tracks, trackToDelete);
    try {
      await this.APIService.deletePlaylistItems(
        currentUser.auth_token,
        playlist.id,
        recordingMBID,
        trackIndex
      );
    } catch (error) {
      this.newAlert("danger", "Error", error.message);
    }
  };

  movePlaylistItem = async (evt: any) => {
    const { currentUser } = this.props;
    const { playlist } = this.props;
    if (!currentUser?.auth_token) {
      this.alertMustBeLoggedIn();
      return;
    }
    try {
      await this.APIService.movePlaylistItem(
        currentUser.auth_token,
        playlist.id,
        evt.item.getAttribute("data-recording-mbid"),
        evt.oldIndex,
        evt.newIndex,
        1
      );
    } catch (error) {
      this.newAlert("danger", "Error", error.message);
    }
  };

  editPlaylist = (
    name: string,
    description: string,
    isPublic: boolean,
    collaborators: string[],
    id?: string
  ) => {
    // Show modal or section with playlist attributes
    // name, description, private/public
    // Then call API endpoint POST  /1/playlist/create
    const content = (
      <div>
        <div>name: {name}</div>
        <div>description: {description}</div>
        <div>isPublic: {isPublic}</div>
        <div>collaborators: {collaborators}</div>
        <div>id: {id}</div>
      </div>
    );
    this.newAlert("success", "Creating playlist", content);
  };

  alertMustBeLoggedIn = () => {
    this.newAlert(
      "danger",
      "Error",
      "You must be logged in for this operation"
    );
  };

  render() {
    const { alerts, currentTrack, playlist } = this.state;
    const { spotify, currentUser, apiUrl } = this.props;
    const { track: tracks } = playlist;
    const hasRightToEdit = this.hasRightToEdit();
    const isOwner = playlist.creator === currentUser?.name;

    const transformedTracks: ListenBrainzTrack[] = playlist.track.map(
      (jspfTrack) => {
        return {
          ...jspfTrack,
          id: PlaylistPage.getRecordingMBIDFromJSPFTrack(jspfTrack),
        } as ListenBrainzTrack;
      }
    );
    return (
      <div role="main">
        <AlertList
          position="bottom-right"
          alerts={alerts}
          timeout={15000}
          dismissTitle="Dismiss"
          onDismiss={this.onAlertDismissed}
        />
        <div className="row">
          <div id="playlist" className="col-md-8">
            <div className="playlist-details row">
              <h1 className="title">
                <div>
                  {playlist.title}
                  <span className="dropdown">
                    <button
                      className="btn btn-link dropdown-toggle"
                      type="button"
                      id="playlistOptionsDropdown"
                      data-toggle="dropdown"
                      aria-haspopup="true"
                      aria-expanded="true"
                    >
                      <FontAwesomeIcon
                        icon={faEllipsisV as IconProp}
                        title="More options"
                      />
                    </button>
                    <ul
                      className="dropdown-menu dropdown-menu-right"
                      aria-labelledby="playlistOptionsDropdown"
                    >
                      <li>
                        <a onClick={this.copyPlaylist} role="button" href="#">
                          Duplicate
                        </a>
                      </li>
                      {isOwner && (
                        <>
                          <li role="separator" className="divider" />
                          <li>
                            <a
                              data-toggle="modal"
                              data-target="#playlistModal"
                              role="button"
                              href="#"
                            >
                              <FontAwesomeIcon icon={faPen as IconProp} /> Edit
                            </a>
                          </li>
                          <li>
                            <a
                              data-toggle="modal"
                              data-target="#confirmDeleteModal"
                              role="button"
                              href="#"
                            >
                              <FontAwesomeIcon icon={faTrashAlt as IconProp} />{" "}
                              Delete
                            </a>
                          </li>
                        </>
                      )}
                    </ul>
                  </span>
                </div>
                <small>
                  {playlist.public ? "Public " : "Private "}
                  playlist by{" "}
                  <a href={`/user/${playlist.creator}`}>{playlist.creator}</a>
                  {playlist.collaborators?.length &&
                    ` | Collaborators: ${playlist.collaborators?.join(", ")}`}
                </small>
              </h1>
              <div className="info">
                <div>{playlist.item_count} tracks</div>
                <div>
                  Created at: {new Date(playlist.date).toLocaleString()}
                </div>
                {playlist.last_modified && (
                  <div>
                    Last modified:{" "}
                    {new Date(playlist.last_modified).toLocaleString()}
                  </div>
                )}
                {playlist.copied_from && (
                  <div>Copied from: {playlist.copied_from}</div>
                )}
              </div>
              <div>{playlist.annotation}</div>
              <hr />
            </div>
            {transformedTracks.length > 5 && (
              <div className="text-center">
                <a
                  className="btn btn-primary"
                  type="button"
                  href="#add-track"
                  style={{ marginBottom: "1em" }}
                >
                  <FontAwesomeIcon icon={faPlusCircle as IconProp} />
                  &nbsp;&nbsp;Add a track
                </a>
              </div>
            )}
            <div id="listens row">
              {transformedTracks.length > 0 ? (
                <ReactSortable
                  handle=".drag-handle"
                  list={transformedTracks}
                  onEnd={this.movePlaylistItem}
                  setList={(newState) =>
                    this.setState({
                      playlist: { ...playlist, track: newState },
                    })
                  }
                >
                  {transformedTracks.map((track: ListenBrainzTrack, index) => {
                    return (
                      <PlaylistItemCard
                        key={track.id}
                        currentUser={currentUser}
                        canEdit={hasRightToEdit}
                        apiUrl={apiUrl}
                        track={track}
                        className={
                          this.isCurrentTrack(track) ? " current-listen" : ""
                        }
                        // metadata={trackMetadataMap[listen.mbid]}
                        currentFeedback={this.getFeedbackForRecordingMbid(
                          track.id
                        )}
                        playTrack={this.playTrack}
                        removeTrackFromPlaylist={this.deletePlaylistItem}
                        updateFeedback={this.updateFeedback}
                        newAlert={this.newAlert}
                      />
                    );
                  })}
                </ReactSortable>
              ) : (
                <div className="lead text-center">
                  <p>No items in this playlist</p>
                </div>
              )}
              <Card className="playlist-item-card row" id="add-track">
                <span>
                  <FontAwesomeIcon icon={faPlusCircle as IconProp} />
                  &nbsp;&nbsp;Add a track
                </span>
                <AsyncSelect
                  className="search"
                  cacheOptions
                  isClearable
                  closeMenuOnSelect={false}
                  loadOptions={this.searchForTrackDebounced}
                  onChange={this.addTrack}
                  placeholder="Artist followed by track name"
                  loadingMessage={() => "Searching for your track…"}
                />
              </Card>
            </div>
            {isOwner && (
              <>
                <CreateOrEditPlaylistModal
                  onSubmit={this.editPlaylist}
                  playlist={playlist}
                />
                <DeletePlaylistConfirmationModal
                  onConfirm={this.deletePlaylist}
                  playlist={playlist}
                />
              </>
            )}
          </div>
          <div
            className="col-md-4"
            // @ts-ignore
            // eslint-disable-next-line no-dupe-keys
            style={{ position: "-webkit-sticky", position: "sticky", top: 20 }}
          >
            <BrainzPlayer
              apiService={this.APIService}
              currentListen={currentTrack}
              direction="down"
              listens={transformedTracks}
              newAlert={this.newAlert}
              onCurrentListenChange={this.handleCurrentTrackChange}
              ref={this.brainzPlayer}
              spotifyUser={spotify}
            />
          </div>
        </div>
      </div>
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const domContainer = document.querySelector("#react-container");
  const propsElement = document.getElementById("react-props");
  let reactProps;
  try {
    reactProps = JSON.parse(propsElement!.innerHTML);
  } catch (err) {
    // TODO: Show error to the user and ask to reload page
  }
  const {
    api_url,
    playlist,
    spotify,
    web_sockets_server_url,
    current_user,
  } = reactProps;

  ReactDOM.render(
    <ErrorBoundary>
      <PlaylistPage
        apiUrl={api_url}
        playlist={playlist}
        spotify={spotify}
        currentUser={current_user}
        webSocketsServerUrl={web_sockets_server_url}
      />
    </ErrorBoundary>,
    domContainer
  );
});