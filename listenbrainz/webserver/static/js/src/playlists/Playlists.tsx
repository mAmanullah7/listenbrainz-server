/* eslint-disable camelcase */

import * as React from "react";
import * as ReactDOM from "react-dom";

import {
  faEllipsisV,
  faPen,
  faPlusCircle,
  faTrashAlt,
} from "@fortawesome/free-solid-svg-icons";

import { AlertList } from "react-bs-notifier";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { IconProp } from "@fortawesome/fontawesome-svg-core";
import APIService from "../APIService";
import Card from "../components/Card";
import CreateOrEditPlaylistModal from "./CreateOrEditPlaylistModal";
import DeletePlaylistConfirmationModal from "./DeletePlaylistConfirmationModal";
import ErrorBoundary from "../ErrorBoundary";

export type UserPlaylistsProps = {
  currentUser?: ListenBrainzUser;
  apiUrl: string;
  playlists?: ListenBrainzPlaylist[];
};

export type UserPlaylistsState = {
  playlists: ListenBrainzPlaylist[];
  playlistSelectedForOperation?: ListenBrainzPlaylist;
  alerts: Alert[];
};

export default class UserPlaylists extends React.Component<
  UserPlaylistsProps,
  UserPlaylistsState
> {
  private APIService: APIService;

  constructor(props: UserPlaylistsProps) {
    super(props);

    this.state = {
      alerts: [],
      playlists: props.playlists || [],
    };

    this.APIService = new APIService(
      props.apiUrl || `${window.location.origin}/1`
    );
  }

  copyPlaylist = (): void => {
    // Call API endpoint
    const { playlistSelectedForOperation } = this.state;
    if (!playlistSelectedForOperation) {
      return;
    }
    this.newAlert(
      "warning",
      "API call placeholder",
      `Copy playlist ${playlistSelectedForOperation.id}`
    );
  };

  deletePlaylist = async (): Promise<void> => {
    const { currentUser } = this.props;
    const { playlistSelectedForOperation: playlist } = this.state;
    if (!currentUser?.auth_token) {
      this.alertMustBeLoggedIn();
      return;
    }
    if (!playlist) {
      this.newAlert("danger", "Error", "No playlist to delete");
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
    } catch (error) {
      this.newAlert("danger", "Error", error.message);
    }
  };

  selectPlaylistForEdit = (playlist: ListenBrainzPlaylist): void => {
    this.setState({ playlistSelectedForOperation: playlist });
  };

  createPlaylist = async (
    name: string,
    description: string,
    isPublic: boolean,
    // Not sure waht to do with those yet
    collaborators: string[],
    id?: string
  ): Promise<void> => {
    const { currentUser } = this.props;
    if (id) {
      this.newAlert(
        "danger",
        "Error",
        "Called createPlaylist method with an ID; should call editPlaylist instead"
      );
      return;
    }
    if (!currentUser?.auth_token) {
      this.alertMustBeLoggedIn();
      return;
    }
    try {
      const newPlaylistId = await this.APIService.createPlaylist(
        currentUser.auth_token,
        name,
        [],
        isPublic,
        description
      );
      this.newAlert(
        "success",
        "Created playlist",
        <>
          Created new playlist{" "}
          <a href={`/playlist/${newPlaylistId}`}>{newPlaylistId}</a>
        </>
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
        <div>isPublic: {isPublic.toString()}</div>
        <div>collaborators: {collaborators.join(", ")}</div>
        <div>id: {id}</div>
      </div>
    );
    this.newAlert("success", "Creating playlist", content);
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

  alertMustBeLoggedIn = () => {
    this.newAlert(
      "danger",
      "Error",
      "You must be logged in for this operation"
    );
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

  render() {
    const { alerts, playlists, playlistSelectedForOperation } = this.state;
    const { currentUser } = this.props;
    return (
      <div>
        <div
          id="playlists-container"
          style={{ display: "flex", flexWrap: "wrap" }}
        >
          {playlists.map((playlist: ListenBrainzPlaylist) => {
            const isOwner = playlist.creator === currentUser?.name;
            return (
              <Card className="playlist" key={playlist.id}>
                <a className="image" href={`/playlist/${playlist.id}`}>
                  <div style={{ background: "palegoldenrod", height: "100%" }}>
                    Images here
                  </div>
                </a>
                <div className="info">
                  <span className="dropdown">
                    <button
                      className="btn btn-link dropdown-toggle pull-right"
                      type="button"
                      id="playlistOptionsDropdown"
                      data-toggle="dropdown"
                      aria-haspopup="true"
                      aria-expanded="true"
                      onClick={this.selectPlaylistForEdit.bind(this, playlist)}
                    >
                      <FontAwesomeIcon
                        icon={faEllipsisV as IconProp}
                        title="More options"
                      />
                    </button>
                    <ul
                      className="dropdown-menu"
                      aria-labelledby="playlistOptionsDropdown"
                    >
                      <li>
                        <button onClick={this.copyPlaylist} type="button">
                          Duplicate
                        </button>
                      </li>
                      {isOwner && (
                        <>
                          <li role="separator" className="divider" />
                          <li>
                            <button
                              type="button"
                              data-toggle="modal"
                              data-target="#playlistEditModal"
                            >
                              <FontAwesomeIcon icon={faPen as IconProp} /> Edit
                            </button>
                          </li>
                          <li>
                            <button
                              type="button"
                              data-toggle="modal"
                              data-target="#confirmDeleteModal"
                            >
                              <FontAwesomeIcon icon={faTrashAlt as IconProp} />{" "}
                              Delete
                            </button>
                          </li>
                        </>
                      )}
                    </ul>
                  </span>
                  <a href={`/playlist/${playlist.id}`}>
                    {playlist.title}
                    <br />
                    {playlist.annotation}
                    <br />
                    Last Modified: {playlist.last_modified}
                    <br />
                    Created at:{playlist.date}
                  </a>
                </div>
              </Card>
            );
          })}
          <Card
            className="new-playlist"
            data-toggle="modal"
            data-target="#playlistCreateModal"
          >
            <div>
              <FontAwesomeIcon icon={faPlusCircle as IconProp} size="2x" />
              <span>Create new playlist</span>
            </div>
          </Card>
          <CreateOrEditPlaylistModal
            onSubmit={this.createPlaylist}
            htmlId="playlistCreateModal"
          />
          {playlistSelectedForOperation &&
            playlistSelectedForOperation.creator === currentUser?.name && (
              <>
                <CreateOrEditPlaylistModal
                  onSubmit={this.editPlaylist}
                  playlist={playlistSelectedForOperation}
                  htmlId="playlistEditModal"
                />
                <DeletePlaylistConfirmationModal
                  onConfirm={this.deletePlaylist}
                  playlist={playlistSelectedForOperation}
                />
              </>
            )}
        </div>
        <AlertList
          position="bottom-right"
          alerts={alerts}
          timeout={15000}
          dismissTitle="Dismiss"
          onDismiss={this.onAlertDismissed}
        />
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
    // Show error to the user and ask to reload page
  }
  const { current_user, api_url: apiUrl } = reactProps;
  ReactDOM.render(
    <ErrorBoundary>
      <UserPlaylists apiUrl={apiUrl} currentUser={current_user} />
    </ErrorBoundary>,
    domContainer
  );
});