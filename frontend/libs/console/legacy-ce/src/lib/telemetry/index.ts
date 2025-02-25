import endpoints from '@/Endpoints';
import globals from '@/Globals';
import { sanitiseUrl } from '@/telemetry/filters';
import { Driver } from '@/dataSources';

export type RunTimeErrorEvent = {
  type: 'RUN_TIME_ERROR';
  data: {
    message: string;
    stack?: string;
  };
};

export type ConnectDBEvent = {
  type: 'CONNECT_DB';
  data: {
    db_kind: Driver;
    entity_count?: number;
    entity_hash?: string;
  };
};

export type SetFeatureFlagEvent = {
  type: 'SET_FEATURE_FLAG';
  data: {
    feature_flag: string;
    value: boolean;
  };
};

export type TelemetryEvent =
  | RunTimeErrorEvent
  | ConnectDBEvent
  | SetFeatureFlagEvent;

export type TelemetryPayload = {
  server_version: string;
  url: string;
  console_mode: string;
  console_type: string;
  cli_uuid: string;
  server_uuid: string;
  event_type: TelemetryEvent['type'];
  event_data: TelemetryEvent['data'];
};

const createClient = () => {
  if (globals.enableTelemetry) {
    try {
      const client = new WebSocket(endpoints.telemetryServer);
      client.onerror = e => {
        console.error(`WebSocket Error for Events${e}`);
      };
      return client;
    } catch (e) {
      console.error('Unable to initialise telemetry client', e);
      return null;
    }
  }
  return null;
};

let client = createClient();
if (client) {
  const onClose = () => {
    client = createClient();
    if (client) {
      client.onclose = onClose;
    }
  };
  client.onclose = onClose;
}

const isTelemetryConnectionReady = () => {
  return !!(client && client.readyState === client.OPEN);
};

export const sendTelemetryEvent = (event: TelemetryEvent) => {
  if (client && isTelemetryConnectionReady()) {
    const payload: TelemetryPayload = {
      server_version: globals.serverVersion,
      url: sanitiseUrl(window.location.pathname),
      console_mode: globals.consoleMode,
      console_type: globals.consoleType,
      cli_uuid: globals.cliUUID,
      server_uuid: globals.hasuraCloudProjectId || globals.hasuraUUID,
      event_type: event.type,
      event_data: event.data,
    };
    client.send(
      JSON.stringify({ data: payload, topic: globals.telemetryTopic })
    );
  }
};

export const trackRuntimeError = (error: Error) => {
  sendTelemetryEvent({
    type: 'RUN_TIME_ERROR',
    data: { message: error.message, stack: error.stack },
  });
};
