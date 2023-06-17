import { HomeAssistant } from 'custom-card-helpers';
import add from 'date-fns/add';
import endOfHour from 'date-fns/endOfHour';
import startOfHour from 'date-fns/startOfHour';
import { CameraConfig, CardWideConfig, ExtendedHomeAssistant } from '../../types';
import { ViewMedia } from '../../view/media';
import { RecordingSegmentsCache, RequestCache } from '../cache';
import {
  CameraManagerEngine,
  CAMERA_MANAGER_ENGINE_EVENT_LIMIT_DEFAULT,
} from '../engine';
import { DateRange } from '../range';
import {
  CameraManagerCameraMetadata,
  CameraManagerCameraCapabilities,
  CameraManagerMediaCapabilities,
  DataQuery,
  Engine,
  EventQuery,
  EventQueryResults,
  EventQueryResultsMap,
  PartialEventQuery,
  PartialRecordingQuery,
  PartialRecordingSegmentsQuery,
  QueryResults,
  QueryResultsType,
  QueryReturnType,
  QueryType,
  RecordingQuery,
  RecordingQueryResults,
  RecordingQueryResultsMap,
  RecordingSegment,
  RecordingSegmentsQuery,
  RecordingSegmentsQueryResultsMap,
  CameraEndpointsContext,
  CameraConfigs,
  CameraEndpoints,
  CameraEndpoint,
  MediaMetadataQuery,
  MediaMetadataQueryResults,
  MediaMetadataQueryResultsMap,
  EngineOptions,
} from '../types';
import {
  FrigateEventQueryResults,
  FrigateRecordingQueryResults,
  FrigateRecordingSegmentsQueryResults,
  FrigateRecording,
} from './types';
import {
  getEvents,
  getEventSummary,
  getRecordingSegments,
  getRecordingsSummary,
  NativeFrigateEventQuery,
  NativeFrigateRecordingSegmentsQuery,
  retainEvent,
} from './requests';
import isEqual from 'lodash-es/isEqual';
import orderBy from 'lodash-es/orderBy';
import throttle from 'lodash-es/throttle';
import uniqWith from 'lodash-es/uniqWith';
import {
  allPromises,
  formatDate,
  prettifyTitle,
  runWhenIdleIfSupported,
} from '../../utils/basic';
import fromUnixTime from 'date-fns/fromUnixTime';
import sum from 'lodash-es/sum';
import { FrigateViewMediaClassifier } from './media-classifier';
import { ViewMediaClassifier } from '../../view/media-classifier';
import { FrigateViewMediaFactory } from './media';
import { log } from '../../utils/debug';
import { getEntityTitle } from '../../utils/ha';
import { EntityRegistryManager } from '../../utils/ha/entity-registry';
import { Entity } from '../../utils/ha/entity-registry/types';
import { CameraInitializationError } from '../error';
import { localize } from '../../localize/localize';
import uniq from 'lodash-es/uniq';
import format from 'date-fns/format';
import { GenericCameraManagerEngine } from '../generic/engine-generic';
import frigateLogo from './assets/frigate-logo-dark.svg';
import { getCameraEntityFromConfig } from '../util';

const EVENT_REQUEST_CACHE_MAX_AGE_SECONDS = 60;
const RECORDING_SUMMARY_REQUEST_CACHE_MAX_AGE_SECONDS = 60;
const MEDIA_METADATA_REQUEST_CACHE_AGE_SECONDS = 60;

const CAMERA_BIRDSEYE = 'birdseye' as const;

class FrigateQueryResultsClassifier {
  public static isFrigateEventQueryResults(
    results: QueryResults,
  ): results is FrigateEventQueryResults {
    return results.engine === Engine.Frigate && results.type === QueryResultsType.Event;
  }

  public static isFrigateRecordingQueryResults(
    results: QueryResults,
  ): results is FrigateRecordingQueryResults {
    return (
      results.engine === Engine.Frigate && results.type === QueryResultsType.Recording
    );
  }

  public static isFrigateRecordingSegmentsResults(
    results: QueryResults,
  ): results is FrigateRecordingSegmentsQueryResults {
    return (
      results.engine === Engine.Frigate &&
      results.type === QueryResultsType.RecordingSegments
    );
  }
}

export class FrigateCameraManagerEngine
  extends GenericCameraManagerEngine
  implements CameraManagerEngine
{
  protected _recordingSegmentsCache: RecordingSegmentsCache;
  protected _requestCache: RequestCache;
  protected _cardWideConfig: CardWideConfig;

  // Garbage collect segments at most once an hour.
  protected _throttledSegmentGarbageCollector = throttle(
    this._garbageCollectSegments.bind(this),
    60 * 60 * 1000,
    { leading: false, trailing: true },
  );

  constructor(
    cardWideConfig: CardWideConfig,
    recordingSegmentsCache: RecordingSegmentsCache,
    requestCache: RequestCache,
  ) {
    super();
    this._cardWideConfig = cardWideConfig;
    this._recordingSegmentsCache = recordingSegmentsCache;
    this._requestCache = requestCache;
  }

  public getEngineType(): Engine {
    return Engine.Frigate;
  }

  public async initializeCamera(
    hass: HomeAssistant,
    entityRegistryManager: EntityRegistryManager,
    cameraConfig: CameraConfig,
  ): Promise<CameraConfig> {
    const hasCameraName = !!cameraConfig.frigate?.camera_name;
    const hasAutoTriggers =
      cameraConfig.triggers.motion || cameraConfig.triggers.occupancy;

    let entity: Entity | null = null;
    const cameraEntity = getCameraEntityFromConfig(cameraConfig);

    // Entity information is required if the Frigate camera name is missing, or
    // if the entity requires automatic resolution of motion/occupancy sensors.
    if (cameraEntity && (!hasCameraName || hasAutoTriggers)) {
      try {
        entity = await entityRegistryManager.getEntity(hass, cameraEntity);
      } catch (e) {
        throw new CameraInitializationError(
          localize('error.no_camera_entity'),
          cameraConfig,
        );
      }
    }

    if (entity && !hasCameraName) {
      const resolvedName = this._getFrigateCameraNameFromEntity(entity);
      if (resolvedName) {
        cameraConfig.frigate.camera_name = resolvedName;
      }
    }

    if (hasAutoTriggers) {
      // Try to find the correct entities for the motion & occupancy sensors.
      // We know they are binary_sensors, and that they'll have the same
      // config entry ID as the camera. Searching via unique_id ensures this
      // search still works if the user renames the entity_id.
      const binarySensorEntities = await entityRegistryManager.getMatchingEntities(
        hass,
        (ent) =>
          ent.config_entry_id === entity?.config_entry_id &&
          !ent.disabled_by &&
          ent.entity_id.startsWith('binary_sensor.'),
      );

      if (cameraConfig.triggers.motion) {
        const motionEntity = this._getMotionSensor(cameraConfig, [
          ...binarySensorEntities.values(),
        ]);
        if (motionEntity) {
          cameraConfig.triggers.entities.push(motionEntity);
        }
      }

      if (cameraConfig.triggers.occupancy) {
        const occupancyEntities = this._getOccupancySensor(cameraConfig, [
          ...binarySensorEntities.values(),
        ]);
        if (occupancyEntities) {
          cameraConfig.triggers.entities.push(...occupancyEntities);
        }
      }

      // De-duplicate triggering entities.
      cameraConfig.triggers.entities = uniq(cameraConfig.triggers.entities);
    }

    return cameraConfig;
  }

  /**
   * Get the Frigate camera name from an entity.
   * @returns The Frigate camera name or null if unavailable.
   */
  protected _getFrigateCameraNameFromEntity(entity: Entity): string | null {
    if (
      entity.platform === 'frigate' &&
      entity.unique_id &&
      typeof entity.unique_id === 'string'
    ) {
      const match = entity.unique_id.match(/:camera:(?<camera>[^:]+)$/);
      if (match && match.groups) {
        return match.groups['camera'];
      }
    }
    return null;
  }

  /**
   * Get the motion sensor entity for a given camera.
   * @param cache The EntityCache of entity registry information.
   * @param cameraConfig The camera config in question.
   * @returns The entity id of the motion sensor or null.
   */
  protected _getMotionSensor(
    cameraConfig: CameraConfig,
    entities: Entity[],
  ): string | null {
    if (cameraConfig.frigate.camera_name) {
      return (
        entities.find(
          (entity) =>
            typeof entity.unique_id === 'string' &&
            !!entity.unique_id?.match(
              new RegExp(`:motion_sensor:${cameraConfig.frigate.camera_name}`),
            ),
        )?.entity_id ?? null
      );
    }
    return null;
  }

  /**
   * Get the occupancy sensor entity for a given camera.
   * @param cache The EntityCache of entity registry information.
   * @param cameraConfig The camera config in question.
   * @returns The entity id of the occupancy sensor or null.
   */
  protected _getOccupancySensor(
    cameraConfig: CameraConfig,
    entities: Entity[],
  ): string[] | null {
    const entityIDs: string[] = [];
    const addEntityIDIfFound = (cameraOrZone: string, label: string): void => {
      const entityID =
        entities.find(
          (entity) =>
            typeof entity.unique_id === 'string' &&
            !!entity.unique_id?.match(
              new RegExp(`:occupancy_sensor:${cameraOrZone}_${label}`),
            ),
        )?.entity_id ?? null;
      if (entityID) {
        entityIDs.push(entityID);
      }
    };

    if (cameraConfig.frigate.camera_name) {
      // If zone(s) are specified, the master occupancy sensor for the overall
      // camera is not used by default (but could be manually added by the
      // user).
      const camerasAndZones = cameraConfig.frigate.zones?.length
        ? cameraConfig.frigate.zones
        : [cameraConfig.frigate.camera_name];

      const labels = cameraConfig.frigate.labels?.length
        ? cameraConfig.frigate.labels
        : ['all'];
      for (const cameraOrZone of camerasAndZones) {
        for (const label of labels) {
          addEntityIDIfFound(cameraOrZone, label);
        }
      }

      if (entityIDs.length) {
        return entityIDs;
      }
    }
    return null;
  }

  public async getMediaDownloadPath(
    _hass: ExtendedHomeAssistant,
    cameraConfig: CameraConfig,
    media: ViewMedia,
  ): Promise<CameraEndpoint | null> {
    if (FrigateViewMediaClassifier.isFrigateEvent(media)) {
      return {
        endpoint:
          `/api/frigate/${cameraConfig.frigate.client_id}` +
          `/notifications/${media.getID()}/` +
          `${ViewMediaClassifier.isClip(media) ? 'clip.mp4' : 'snapshot.jpg'}` +
          `?download=true`,
        sign: true,
      };
    } else if (FrigateViewMediaClassifier.isFrigateRecording(media)) {
      return {
        endpoint:
          `/api/frigate/${cameraConfig.frigate.client_id}` +
          `/recording/${cameraConfig.frigate.camera_name}` +
          `/start/${Math.floor(media.getStartTime().getTime() / 1000)}` +
          `/end/${Math.floor(media.getEndTime().getTime() / 1000)}` +
          `?download=true`,
        sign: true,
      };
    }
    return null;
  }

  public generateDefaultEventQuery(
    cameras: CameraConfigs,
    cameraIDs: Set<string>,
    query?: PartialEventQuery,
  ): EventQuery[] | null {
    const relevantCameraConfigs = Array.from(cameraIDs).map((cameraID) =>
      cameras.get(cameraID),
    );

    // If all cameras specify exactly the same zones or labels (incl. none), we
    // can use a single batch query which will be better performance wise,
    // otherwise we must fan out to multiple queries in order to precisely match
    // the user's intent.
    const uniqueZoneArrays = uniqWith(
      relevantCameraConfigs.map((config) => config?.frigate.zones),
      isEqual,
    );
    const uniqueLabelArrays = uniqWith(
      relevantCameraConfigs.map((config) => config?.frigate.labels),
      isEqual,
    );

    if (uniqueZoneArrays.length === 1 && uniqueLabelArrays.length === 1) {
      return [
        {
          type: QueryType.Event,
          cameraIDs: cameraIDs,
          ...(uniqueLabelArrays[0] && { what: new Set(uniqueLabelArrays[0]) }),
          ...(uniqueZoneArrays[0] && { where: new Set(uniqueZoneArrays[0]) }),
          ...query,
        },
      ];
    }

    const output: EventQuery[] = [];
    for (const cameraID of cameraIDs) {
      const cameraConfig = cameras.get(cameraID);
      if (cameraConfig) {
        output.push({
          type: QueryType.Event,
          cameraIDs: new Set([cameraID]),
          ...(cameraConfig.frigate.labels && {
            what: new Set(cameraConfig.frigate.labels),
          }),
          ...(cameraConfig.frigate.zones && {
            where: new Set(cameraConfig.frigate.zones),
          }),
          ...query,
        });
      }
    }
    return output.length ? output : null;
  }

  public generateDefaultRecordingQuery(
    _cameras: CameraConfigs,
    cameraIDs: Set<string>,
    query?: PartialRecordingQuery,
  ): RecordingQuery[] {
    return [
      {
        type: QueryType.Recording,
        cameraIDs: cameraIDs,
        ...query,
      },
    ];
  }

  public generateDefaultRecordingSegmentsQuery(
    _cameras: CameraConfigs,
    cameraIDs: Set<string>,
    query: PartialRecordingSegmentsQuery,
  ): RecordingSegmentsQuery[] | null {
    if (!query.start || !query.end) {
      return null;
    }
    return [
      {
        type: QueryType.RecordingSegments,
        cameraIDs: cameraIDs,
        start: query.start,
        end: query.end,
        ...query,
      },
    ];
  }

  public async favoriteMedia(
    hass: HomeAssistant,
    cameraConfig: CameraConfig,
    media: ViewMedia,
    favorite: boolean,
  ): Promise<void> {
    if (!FrigateViewMediaClassifier.isFrigateEvent(media)) {
      return;
    }

    await retainEvent(hass, cameraConfig.frigate.client_id, media.getID(), favorite);
    media.setFavorite(favorite);
  }

  protected _buildInstanceToCameraIDMapFromQuery(
    cameras: CameraConfigs,
    cameraIDs: Set<string>,
  ): Map<string, Set<string>> {
    const output: Map<string, Set<string>> = new Map();
    for (const cameraID of cameraIDs) {
      const cameraConfig = this._getQueryableCameraConfig(cameras, cameraID);
      const clientID = cameraConfig?.frigate.client_id;
      if (clientID) {
        if (!output.has(clientID)) {
          output.set(clientID, new Set());
        }
        output.get(clientID)?.add(cameraID);
      }
    }
    return output;
  }

  protected _getFrigateCameraNamesForCameraIDs(
    cameras: CameraConfigs,
    cameraIDs: Set<string>,
  ): Set<string> {
    const output = new Set<string>();
    for (const cameraID of cameraIDs) {
      const cameraConfig = this._getQueryableCameraConfig(cameras, cameraID);
      if (cameraConfig?.frigate.camera_name) {
        output.add(cameraConfig.frigate.camera_name);
      }
    }
    return output;
  }

  public async getEvents(
    hass: HomeAssistant,
    cameras: CameraConfigs,
    query: EventQuery,
    engineOptions?: EngineOptions,
  ): Promise<EventQueryResultsMap | null> {
    const output: EventQueryResultsMap = new Map();

    const processInstanceQuery = async (
      instanceID: string,
      cameraIDs?: Set<string>,
    ): Promise<void> => {
      if (!cameraIDs || !cameraIDs.size) {
        return;
      }
      const instanceQuery = { ...query, cameraIDs: cameraIDs };
      const cachedResult =
        engineOptions?.useCache ?? true ? this._requestCache.get(instanceQuery) : null;
      if (cachedResult) {
        output.set(query, cachedResult as EventQueryResults);
        return;
      }

      const nativeQuery: NativeFrigateEventQuery = {
        instance_id: instanceID,
        cameras: Array.from(this._getFrigateCameraNamesForCameraIDs(cameras, cameraIDs)),
        ...(query.what && { labels: Array.from(query.what) }),
        ...(query.where && { zones: Array.from(query.where) }),
        ...(query.tags && { sub_labels: Array.from(query.tags) }),
        ...(query.end && { before: Math.floor(query.end.getTime() / 1000) }),
        ...(query.start && { after: Math.floor(query.start.getTime() / 1000) }),
        ...(query.limit && { limit: query.limit }),
        ...(query.hasClip && { has_clip: query.hasClip }),
        ...(query.hasSnapshot && { has_snapshot: query.hasSnapshot }),
        ...(query.favorite && { favorites: query.favorite }),
        limit: query?.limit ?? CAMERA_MANAGER_ENGINE_EVENT_LIMIT_DEFAULT,
      };

      const result: FrigateEventQueryResults = {
        type: QueryResultsType.Event,
        engine: Engine.Frigate,
        instanceID: instanceID,
        events: await getEvents(hass, nativeQuery),
        expiry: add(new Date(), { seconds: EVENT_REQUEST_CACHE_MAX_AGE_SECONDS }),
        cached: false,
      };

      if (engineOptions?.useCache ?? true) {
        this._requestCache.set(query, { ...result, cached: true }, result.expiry);
      }
      output.set(instanceQuery, result);
    };

    // Frigate allows multiple cameras to be searched for events in a single
    // query. Break them down into groups of cameras per Frigate instance, then
    // query once per instance for all cameras in that instance.
    const instances = this._buildInstanceToCameraIDMapFromQuery(
      cameras,
      query.cameraIDs,
    );

    await Promise.all(
      Array.from(instances.keys()).map((instanceID) =>
        processInstanceQuery(instanceID, instances.get(instanceID)),
      ),
    );
    return output.size ? output : null;
  }

  public async getRecordings(
    hass: HomeAssistant,
    cameras: CameraConfigs,
    query: RecordingQuery,
    engineOptions?: EngineOptions,
  ): Promise<RecordingQueryResultsMap | null> {
    const output: RecordingQueryResultsMap = new Map();

    const processQuery = async (
      baseQuery: RecordingQuery,
      cameraID: string,
    ): Promise<void> => {
      const query = { ...baseQuery, cameraIDs: new Set([cameraID]) };
      const cachedResult =
        engineOptions?.useCache ?? true ? this._requestCache.get(query) : null;
      if (cachedResult) {
        output.set(query, cachedResult as RecordingQueryResults);
        return;
      }

      const cameraConfig = this._getQueryableCameraConfig(cameras, cameraID);
      if (!cameraConfig || !cameraConfig.frigate.camera_name) {
        return;
      }

      const recordingSummary = await getRecordingsSummary(
        hass,
        cameraConfig.frigate.client_id,
        cameraConfig.frigate.camera_name,
      );

      let recordings: FrigateRecording[] = [];

      for (const dayData of recordingSummary ?? []) {
        for (const hourData of dayData.hours) {
          const hour = add(dayData.day, { hours: hourData.hour });
          const startHour = startOfHour(hour);
          const endHour = endOfHour(hour);
          if (
            (!query.start || startHour >= query.start) &&
            (!query.end || endHour <= query.end)
          ) {
            recordings.push({
              cameraID: cameraID,
              startTime: startHour,
              endTime: endHour,
              events: hourData.events,
            });
          }
        }
      }

      if (query.limit !== undefined) {
        // Frigate does not natively support a way to limit recording searches so
        // this simulates it.
        recordings = orderBy(
          recordings,
          (recording: FrigateRecording) => recording.startTime,
          'desc',
        ).slice(0, query.limit);
      }

      const result: FrigateRecordingQueryResults = {
        type: QueryResultsType.Recording,
        engine: Engine.Frigate,
        instanceID: cameraConfig.frigate.client_id,
        recordings: recordings,
        expiry: add(new Date(), {
          seconds: RECORDING_SUMMARY_REQUEST_CACHE_MAX_AGE_SECONDS,
        }),
        cached: false,
      };
      if (engineOptions?.useCache ?? true) {
        this._requestCache.set(query, { ...result, cached: true }, result.expiry);
      }
      output.set(query, result);
    };

    // Frigate recordings can only be queried for a single camera, so fan out
    // the inbound query into multiple outbound queries.
    await Promise.all(
      Array.from(query.cameraIDs).map((cameraID) => processQuery(query, cameraID)),
    );
    return output.size ? output : null;
  }

  public async getRecordingSegments(
    hass: HomeAssistant,
    cameras: CameraConfigs,
    query: RecordingSegmentsQuery,
    engineOptions?: EngineOptions,
  ): Promise<RecordingSegmentsQueryResultsMap | null> {
    const output: RecordingSegmentsQueryResultsMap = new Map();

    const processQuery = async (
      baseQuery: RecordingSegmentsQuery,
      cameraID: string,
    ): Promise<void> => {
      const query = { ...baseQuery, cameraIDs: new Set([cameraID]) };
      const cameraConfig = this._getQueryableCameraConfig(cameras, cameraID);
      if (!cameraConfig || !cameraConfig.frigate.camera_name) {
        return;
      }

      const range: DateRange = { start: query.start, end: query.end };

      // A note on Frigate Recording Segments:
      // - There is an internal cache at the engine level for segments to allow
      //   caching "within an existing query" (e.g. if we already cached hour
      //   1-8, we will avoid a fetch if we request hours 2-3 even though the
      //   query is different -- the segments won't be). This is since the
      //   volume of data in segment transfers can be high, and the segments can
      //   be used in high frequency situations (e.g. video seeking).
      const cachedSegments =
        engineOptions?.useCache ?? true
          ? this._recordingSegmentsCache.get(cameraID, range)
          : null;
      if (cachedSegments) {
        output.set(query, <FrigateRecordingSegmentsQueryResults>{
          type: QueryResultsType.RecordingSegments,
          engine: Engine.Frigate,
          instanceID: cameraConfig.frigate.client_id,
          segments: cachedSegments,
          cached: true,
        });
        return;
      }

      const request: NativeFrigateRecordingSegmentsQuery = {
        instance_id: cameraConfig.frigate.client_id,
        camera: cameraConfig.frigate.camera_name,
        after: Math.floor(query.start.getTime() / 1000),
        before: Math.floor(query.end.getTime() / 1000),
      };

      const segments = await getRecordingSegments(hass, request);

      if (engineOptions?.useCache ?? true) {
        this._recordingSegmentsCache.add(cameraID, range, segments);
      }

      output.set(query, <FrigateRecordingSegmentsQueryResults>{
        type: QueryResultsType.RecordingSegments,
        engine: Engine.Frigate,
        instanceID: cameraConfig.frigate.client_id,
        segments: segments,
        cached: false,
      });
    };

    // Frigate recording segments can only be queried for a single camera, so
    // fan out the inbound query into multiple outbound queries.
    await Promise.all(
      Array.from(query.cameraIDs).map((cameraID) => processQuery(query, cameraID)),
    );

    runWhenIdleIfSupported(() => this._throttledSegmentGarbageCollector(hass, cameras));
    return output.size ? output : null;
  }

  protected _getCameraIDMatch(
    cameras: CameraConfigs,
    query: DataQuery,
    instanceID: string,
    cameraName: string,
  ): string | null {
    // If the query is only for a single cameraID, all results are assumed to
    // belong to it for performance reasons. Otherwise, we need to map the
    // instanceID and camera name for the known cameras, and get the precise
    // cameraID that matches the expected instance ID / camera name.
    if (query.cameraIDs.size === 1) {
      return [...query.cameraIDs][0];
    }
    for (const [cameraID, cameraConfig] of cameras.entries()) {
      if (
        cameraConfig.frigate.client_id === instanceID &&
        cameraConfig.frigate.camera_name === cameraName
      ) {
        return cameraID;
      }
    }
    return null;
  }

  public generateMediaFromEvents(
    _hass: HomeAssistant,
    cameras: CameraConfigs,
    query: EventQuery,
    results: QueryReturnType<EventQuery>,
  ): ViewMedia[] | null {
    if (!FrigateQueryResultsClassifier.isFrigateEventQueryResults(results)) {
      return null;
    }

    const output: ViewMedia[] = [];
    for (const event of results.events) {
      const cameraID = this._getCameraIDMatch(
        cameras,
        query,
        results.instanceID,
        event.camera,
      );
      if (!cameraID) {
        continue;
      }
      const cameraConfig = this._getQueryableCameraConfig(cameras, cameraID);
      if (!cameraConfig) {
        continue;
      }
      let mediaType: 'clip' | 'snapshot' | null = null;
      if (
        !query.hasClip &&
        !query.hasSnapshot &&
        (event.has_clip || event.has_snapshot)
      ) {
        mediaType = event.has_clip ? 'clip' : 'snapshot';
      } else if (query.hasSnapshot && event.has_snapshot) {
        mediaType = 'snapshot';
      } else if (query.hasClip && event.has_clip) {
        mediaType = 'clip';
      }
      if (!mediaType) {
        continue;
      }
      const media = FrigateViewMediaFactory.createEventViewMedia(
        mediaType,
        cameraID,
        cameraConfig,
        event,
        event.sub_label ? this._splitSubLabels(event.sub_label) : undefined,
      );
      if (media) {
        output.push(media);
      }
    }
    return output;
  }

  public generateMediaFromRecordings(
    hass: HomeAssistant,
    cameras: CameraConfigs,
    _query: RecordingQuery,
    results: QueryReturnType<RecordingQuery>,
  ): ViewMedia[] | null {
    if (!FrigateQueryResultsClassifier.isFrigateRecordingQueryResults(results)) {
      return null;
    }

    const output: ViewMedia[] = [];
    for (const recording of results.recordings) {
      const cameraConfig = this._getQueryableCameraConfig(cameras, recording.cameraID);
      if (!cameraConfig) {
        continue;
      }
      const media = FrigateViewMediaFactory.createRecordingViewMedia(
        recording.cameraID,
        recording,
        cameraConfig,
        this.getCameraMetadata(hass, cameraConfig).title,
      );
      if (media) {
        output.push(media);
      }
    }
    return output;
  }

  public getQueryResultMaxAge(query: DataQuery): number | null {
    if (query.type === QueryType.Event) {
      return EVENT_REQUEST_CACHE_MAX_AGE_SECONDS;
    } else if (query.type === QueryType.Recording) {
      return RECORDING_SUMMARY_REQUEST_CACHE_MAX_AGE_SECONDS;
    }
    return null;
  }

  public async getMediaSeekTime(
    hass: HomeAssistant,
    cameras: CameraConfigs,
    media: ViewMedia,
    target: Date,
    engineOptions?: EngineOptions,
  ): Promise<number | null> {
    const start = media.getStartTime();
    const end = media.getEndTime();
    if (!start || !end || target < start || target > end) {
      return null;
    }

    const cameraID = media.getCameraID();
    const query: RecordingSegmentsQuery = {
      cameraIDs: new Set([cameraID]),
      start: start,
      end: end,
      type: QueryType.RecordingSegments,
    };

    const results = await this.getRecordingSegments(hass, cameras, query, engineOptions);

    if (results) {
      return this._getSeekTimeInSegments(
        start,
        target,
        // There will only be a single result since Frigate recording segments
        // searches are per camera which is specified singularly above.
        Array.from(results.values())[0].segments,
      );
    }
    return null;
  }

  protected _getQueryableCameraConfig(
    cameras: CameraConfigs,
    cameraID: string,
  ): CameraConfig | null {
    const cameraConfig = cameras.get(cameraID);
    if (!cameraConfig || cameraConfig.frigate.camera_name == CAMERA_BIRDSEYE) {
      return null;
    }
    return cameraConfig;
  }

  protected _splitSubLabels(input: string): string[] {
    // A note on Frigate sub_labels: As of Frigate v0.12 sub_labels is a string
    // (not an array) per event, but may contain comma-separated values (e.g.
    // double-take (https://github.com/jakowenko/double-take) identifying two
    // people in the same photo). When we search for multiple sub_labels, the
    // integration will comma-join them together, then the Frigate backend will
    // do the magic to match exactly or against a comma-separated part.
    return input.split(',').map((s) => s.trim());
  }

  public async getMediaMetadata(
    hass: HomeAssistant,
    cameras: CameraConfigs,
    query: MediaMetadataQuery,
    engineOptions?: EngineOptions,
  ): Promise<MediaMetadataQueryResultsMap | null> {
    const output: MediaMetadataQueryResultsMap = new Map();
    if ((engineOptions?.useCache ?? true) && this._requestCache.has(query)) {
      const cachedResult = <MediaMetadataQueryResults | null>(
        this._requestCache.get(query)
      );
      if (cachedResult) {
        output.set(query, cachedResult as MediaMetadataQueryResults);
        return output;
      }
    }

    const what: Set<string> = new Set();
    const where: Set<string> = new Set();
    const days: Set<string> = new Set();
    const tags: Set<string> = new Set();

    const instances = this._buildInstanceToCameraIDMapFromQuery(
      cameras,
      query.cameraIDs,
    );

    const processEventSummary = async (
      instanceID: string,
      cameraIDs: Set<string>,
    ): Promise<void> => {
      const cameraNames = this._getFrigateCameraNamesForCameraIDs(cameras, cameraIDs);
      for (const entry of await getEventSummary(hass, instanceID)) {
        if (!cameraNames.has(entry.camera)) {
          // If this entry applies to a camera that *is* in this Frigate
          // instance, but is *not* a configured camera in the card, skip it.
          continue;
        }
        if (entry.label) {
          what.add(entry.label);
        }
        if (entry.zones.length) {
          entry.zones.forEach(where.add, where);
        }
        if (entry.day) {
          days.add(entry.day);
        }
        if (entry.sub_label) {
          this._splitSubLabels(entry.sub_label).forEach(tags.add, tags);
        }
      }
    };

    const processRecordings = async (cameraIDs: Set<string>): Promise<void> => {
      const recordings = await this.getRecordings(
        hass,
        cameras,
        {
          type: QueryType.Recording,
          cameraIDs: cameraIDs,
        },
        engineOptions,
      );
      if (!recordings) {
        return;
      }

      for (const result of recordings.values()) {
        if (!FrigateQueryResultsClassifier.isFrigateRecordingQueryResults(result)) {
          continue;
        }

        for (const recording of result.recordings) {
          // Frigate recordings are always 1 hour long, i.e. never span a day.
          days.add(formatDate(recording.startTime));
        }
      }
    };

    await allPromises([...instances.entries()], ([instanceID, cameraIDs]) =>
      (async () => {
        await Promise.all([
          processEventSummary(instanceID, cameraIDs),
          processRecordings(cameraIDs),
        ]);
      })(),
    );

    const result: MediaMetadataQueryResults = {
      type: QueryResultsType.MediaMetadata,
      engine: Engine.Frigate,
      metadata: {
        ...(what.size && { what: what }),
        ...(where.size && { where: where }),
        ...(days.size && { days: days }),
        ...(tags.size && { tags: tags }),
      },
      expiry: add(new Date(), { seconds: MEDIA_METADATA_REQUEST_CACHE_AGE_SECONDS }),
      cached: false,
    };

    if (engineOptions?.useCache ?? true) {
      this._requestCache.set(query, { ...result, cached: true }, result.expiry);
    }
    output.set(query, result);
    return output;
  }

  /**
   * Garbage collect recording segments that no longer feature in the recordings
   * returned by the Frigate backend.
   */
  protected async _garbageCollectSegments(
    hass: HomeAssistant,
    cameras: CameraConfigs,
  ): Promise<void> {
    const cameraIDs = this._recordingSegmentsCache.getCameraIDs();
    const recordingQuery: RecordingQuery = {
      cameraIDs: new Set(cameraIDs),
      type: QueryType.Recording,
    };

    const countSegments = () =>
      sum(
        cameraIDs.map((cameraID) => this._recordingSegmentsCache.getSize(cameraID) ?? 0),
      );
    const segmentsStart = countSegments();

    // Performance: _recordingSegments is potentially very large (e.g. 10K - 1M
    // items) and each item must be examined, so care required here to stick to
    // nothing worse than O(n) performance.
    const getHourID = (cameraID: string, startTime: Date): string => {
      return `${cameraID}/${startTime.getDate()}/${startTime.getHours()}`;
    };

    const results = await this.getRecordings(hass, cameras, recordingQuery);
    if (!results) {
      return;
    }

    for (const [query, result] of results) {
      if (!FrigateQueryResultsClassifier.isFrigateRecordingQueryResults(result)) {
        continue;
      }

      const goodHours: Set<string> = new Set();
      for (const recording of result.recordings) {
        goodHours.add(getHourID(recording.cameraID, recording.startTime));
      }

      // Frigate recordings are always executed individually, so there'll only
      // be a single results.
      const cameraID = Array.from(query.cameraIDs)[0];
      this._recordingSegmentsCache.expireMatches(
        cameraID,
        (segment: RecordingSegment) => {
          const hourID = getHourID(cameraID, fromUnixTime(segment.start_time));
          // ~O(1) lookup time for a JS set.
          return !goodHours.has(hourID);
        },
      );
    }

    log(
      this._cardWideConfig,
      'Frigate Card recording segment garbage collection: ' +
        `Released ${segmentsStart - countSegments()} segment(s)`,
    );
  }

  /**
   * Get the number of seconds to seek into a video stream consisting of the
   * provided segments to reach the target time provided.
   * @param startTime The earliest allowable time to seek from.
   * @param targetTime Target time.
   * @param segments An array of segments dataset items. Must be sorted from oldest to youngest.
   * @returns
   */
  protected _getSeekTimeInSegments(
    startTime: Date,
    targetTime: Date,
    segments: RecordingSegment[],
  ): number | null {
    if (!segments.length) {
      return null;
    }
    let seekMilliseconds = 0;

    // Inspired by: https://github.com/blakeblackshear/frigate/blob/release-0.11.0/web/src/routes/Recording.jsx#L27
    for (const segment of segments) {
      const segmentStart = fromUnixTime(segment.start_time);
      if (segmentStart > targetTime) {
        break;
      }
      const segmentEnd = fromUnixTime(segment.end_time);
      const start = segmentStart < startTime ? startTime : segmentStart;
      const end = segmentEnd > targetTime ? targetTime : segmentEnd;
      seekMilliseconds += end.getTime() - start.getTime();
    }
    return seekMilliseconds / 1000;
  }

  public getCameraCapabilities(
    cameraConfig: CameraConfig,
  ): CameraManagerCameraCapabilities {
    const isBirdseye = cameraConfig.frigate.camera_name === CAMERA_BIRDSEYE;
    return {
      canFavoriteEvents: !isBirdseye,
      canFavoriteRecordings: !isBirdseye,
      canSeek: true,
      supportsClips: !isBirdseye,
      supportsSnapshots: !isBirdseye,
      supportsRecordings: !isBirdseye,
      supportsTimeline: !isBirdseye,
    };
  }

  public getMediaCapabilities(media: ViewMedia): CameraManagerMediaCapabilities {
    return {
      canFavorite: ViewMediaClassifier.isEvent(media),
      canDownload: true,
    };
  }

  public getCameraMetadata(
    hass: HomeAssistant,
    cameraConfig: CameraConfig,
  ): CameraManagerCameraMetadata {
    const metadata = super.getCameraMetadata(hass, cameraConfig);
    return {
      title:
        cameraConfig.title ??
        getEntityTitle(hass, cameraConfig.camera_entity) ??
        getEntityTitle(hass, cameraConfig.webrtc_card?.entity) ??
        prettifyTitle(cameraConfig.frigate?.camera_name) ??
        cameraConfig.id ??
        '',
      icon: metadata.icon,
      engineLogo: frigateLogo,
    };
  }

  public getCameraEndpoints(
    cameraConfig: CameraConfig,
    context?: CameraEndpointsContext,
  ): CameraEndpoints | null {
    const getUIEndpoint = (): CameraEndpoint | null => {
      if (!cameraConfig.frigate.url) {
        return null;
      }
      if (!cameraConfig.frigate.camera_name) {
        return { endpoint: cameraConfig.frigate.url };
      }

      const cameraURL =
        `${cameraConfig.frigate.url}/cameras/` + cameraConfig.frigate.camera_name;

      if (context?.view === 'live') {
        return { endpoint: cameraURL };
      }

      const eventsURL =
        `${cameraConfig.frigate.url}/events?camera=` + cameraConfig.frigate.camera_name;
      const recordingsURL =
        `${cameraConfig.frigate.url}/recording/` + cameraConfig.frigate.camera_name;

      // If media is available, use it since it may result in a more precisely
      // correct URL.
      switch (context?.media?.getMediaType()) {
        case 'clip':
        case 'snapshot':
          return { endpoint: eventsURL };
        case 'recording':
          const startTime = context.media.getStartTime();
          if (startTime) {
            return { endpoint: recordingsURL + format(startTime, 'yyyy-MM-dd/HH') };
          }
      }

      // Otherwise, fall back to just using the view if we have that.
      switch (context?.view) {
        case 'clip':
        case 'clips':
        case 'snapshots':
        case 'snapshot':
          return { endpoint: eventsURL };
        case 'recording':
        case 'recordings':
          return { endpoint: recordingsURL };
      }

      return {
        endpoint: cameraURL,
      };
    };

    const getGo2RTC = (): CameraEndpoint | null => {
      return {
        endpoint:
          `/api/frigate/${cameraConfig.frigate.client_id}` +
          // go2rtc is exposed by the integration under the (slightly
          // misleading) 'mse' path, even though that path can serve all go2rtc
          // modes.
          `/mse/api/ws?src=${
            cameraConfig.go2rtc?.stream ?? cameraConfig.frigate.camera_name
          }`,
        sign: true,
      };
    };

    const getJSMPEG = (): CameraEndpoint | null => {
      return {
        endpoint:
          `/api/frigate/${cameraConfig.frigate.client_id}` +
          `/jsmpeg/${cameraConfig.frigate.camera_name}`,
        sign: true,
      };
    };

    const getWebRTCCard = (): CameraEndpoint | null => {
      // By default use the frigate camera name which is the default recommended
      // setup as per:
      // https://deploy-preview-4055--frigate-docs.netlify.app/guides/configuring_go2rtc/
      //
      // The user may override this in their webrtc_card configuration.
      const endpoint = cameraConfig.frigate.camera_name
        ? cameraConfig.frigate.camera_name
        : null;
      return endpoint ? { endpoint: endpoint } : null;
    };

    const ui = getUIEndpoint();
    const go2rtc = getGo2RTC();
    const jsmpeg = getJSMPEG();
    const webrtcCard = getWebRTCCard();

    return {
      ...(ui && { ui: ui }),
      ...(go2rtc && { go2rtc: go2rtc }),
      ...(jsmpeg && { jsmpeg: jsmpeg }),
      ...(webrtcCard && { webrtcCard: webrtcCard }),
    };
  }
}
