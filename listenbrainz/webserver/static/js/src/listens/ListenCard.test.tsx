import * as React from "react";
import { mount, shallow } from "enzyme";

import ListenCard, { ListenCardProps } from "./ListenCard";

// Font Awesome generates a random hash ID for each icon everytime.
// Mocking Math.random() fixes this
// https://github.com/FortAwesome/react-fontawesome/issues/194#issuecomment-627235075
jest.spyOn(global.Math, "random").mockImplementation(() => 0);

const listen: Listen = {
  listened_at: 0,
  track_metadata: {
    artist_name: "Moondog",
    track_name: "Bird's Lament",
    additional_info: {
      release_mbid: "foo",
      recording_msid: "bar",
    },
  },
};

const props: ListenCardProps = {
  apiUrl: "foobar",
  listen,
  mode: "listens",
  currentFeedback: 1,
  isCurrentUser: true,
  currentUser: { auth_token: "baz", name: "test" },
  playListen: () => {},
  updateFeedback: () => {},
  newAlert: () => {},
};

describe("ListenCard", () => {
  it("renders correctly for mode = 'listens'", () => {
    const wrapper = mount<ListenCard>(<ListenCard {...props} />);

    expect(wrapper).toMatchSnapshot();
  });

  it("renders correctly for mode = 'follow '", () => {
    const wrapper = mount<ListenCard>(
      <ListenCard {...{ ...props, mode: "follow" }} />
    );

    expect(wrapper).toMatchSnapshot();
  });

  it("renders correctly for mode = 'recent '", () => {
    const wrapper = mount<ListenCard>(
      <ListenCard {...{ ...props, mode: "recent" }} />
    );

    expect(wrapper).toMatchSnapshot();
  });
});

describe("componentDidUpdate", () => {
  it("updates the feedbackState", () => {
    const wrapper = shallow<ListenCard>(<ListenCard {...props} />);

    expect(wrapper.state("feedback")).toEqual(1);

    wrapper.setProps({ currentFeedback: -1 });
    expect(wrapper.state("feedback")).toEqual(-1);
  });
});

describe("submitFeedback", () => {
  it("updates feedback state and calls updateFeedback", async () => {
    const wrapper = shallow<ListenCard>(
      <ListenCard {...{ ...props, updateFeedback: jest.fn() }} />
    );
    const instance = wrapper.instance();

    const spy = jest.spyOn(instance.APIService, "submitFeedback");
    spy.mockImplementation(() => Promise.resolve(200));

    expect(wrapper.state("feedback")).toEqual(1);

    await instance.submitFeedback(-1);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("baz", "bar", -1);

    expect(wrapper.state("feedback")).toEqual(-1);
    expect(instance.props.updateFeedback).toHaveBeenCalledTimes(1);
    expect(instance.props.updateFeedback).toHaveBeenCalledWith("bar", -1);
  });

  it("does nothing if isCurrentUser is false", async () => {
    const wrapper = shallow<ListenCard>(
      <ListenCard {...{ ...props, isCurrentUser: false }} />
    );
    const instance = wrapper.instance();

    const spy = jest.spyOn(instance.APIService, "submitFeedback");
    spy.mockImplementation(() => Promise.resolve(200));

    expect(wrapper.state("feedback")).toEqual(1);

    instance.submitFeedback(-1);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(wrapper.state("feedback")).toEqual(1);
  });

  it("does nothing if CurrentUser.authtoken is not set", async () => {
    const wrapper = shallow<ListenCard>(
      <ListenCard
        {...{ ...props, currentUser: { auth_token: undefined, name: "test" } }}
      />
    );
    const instance = wrapper.instance();

    const spy = jest.spyOn(instance.APIService, "submitFeedback");
    spy.mockImplementation(() => Promise.resolve(200));

    expect(wrapper.state("feedback")).toEqual(1);

    instance.submitFeedback(-1);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(wrapper.state("feedback")).toEqual(1);
  });

  it("doesn't update feedback state or call updateFeedback if status code is not 200", async () => {
    const wrapper = shallow<ListenCard>(<ListenCard {...props} />);
    const instance = wrapper.instance();
    props.updateFeedback = jest.fn();

    const spy = jest.spyOn(instance.APIService, "submitFeedback");
    spy.mockImplementation(() => Promise.resolve(201));

    expect(wrapper.state("feedback")).toEqual(1);

    instance.submitFeedback(-1);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("baz", "bar", -1);

    expect(wrapper.state("feedback")).toEqual(1);
    expect(props.updateFeedback).toHaveBeenCalledTimes(0);
  });

  it("calls handleError if error is returned", async () => {
    const wrapper = shallow<ListenCard>(<ListenCard {...props} />);
    const instance = wrapper.instance();
    instance.handleError = jest.fn();

    const spy = jest.spyOn(instance.APIService, "submitFeedback");
    spy.mockImplementation(() => {
      throw new Error("error");
    });

    instance.submitFeedback(-1);
    expect(instance.handleError).toHaveBeenCalledTimes(1);
    expect(instance.handleError).toHaveBeenCalledWith("error");
  });
});

describe("handleError", () => {
  it("calls newAlert", async () => {
    const wrapper = shallow<ListenCard>(
      <ListenCard {...{ ...props, newAlert: jest.fn() }} />
    );
    const instance = wrapper.instance();

    instance.handleError("error");

    expect(instance.props.newAlert).toHaveBeenCalledTimes(1);
    expect(instance.props.newAlert).toHaveBeenCalledWith(
      "danger",
      "Error",
      "error"
    );
  });
});