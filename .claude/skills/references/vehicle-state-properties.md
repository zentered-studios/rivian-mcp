# Vehicle State Properties Reference

All properties confirmed working via live API testing (re-verified October 9, 2026, on a 2025 R1S, software 2026.31.0).
All return `{ timeStamp, value }` unless noted in the Custom Templates section.

Units are determined by the user's in-vehicle settings (km/miles, °C/°F). The API returns raw values without unit metadata. User unit preferences (`distanceUnit`, `temperatureUnit`, `pressureUnit`) are available on `currentUser.settings` (each `{ value }`) but are commonly `null`.

**`vehicleMileage` is in METERS, not km.** Live example: `47393698` = 47,394 km ≈ 29,449 mi. Divide by 1000 for km. (An earlier revision of this doc wrongly labeled it km - corrected July 2026.) `distanceToEmpty` follows the user's in-vehicle distance setting.

## Custom Templates

Three properties require non-standard fragment templates (defined in `TEMPLATE_MAP` in `lib/rivian-api.js`):

| Property          | Fragment                                                          |
| ----------------- | ----------------------------------------------------------------- |
| `cloudConnection` | `{ lastSync isOnline }`                                           |
| `gnssLocation`    | `{ latitude longitude timeStamp }`                                |
| `gnssError`       | `{ timeStamp positionVertical positionHorizontal speed bearing }` |

## Connectivity

| Property          | Value type | Example                                                       |
| ----------------- | ---------- | ------------------------------------------------------------- |
| `cloudConnection` | custom     | `{ isOnline: true, lastSync: "2026-04-09T22:14:47Z" }`        |
| `gnssLocation`    | custom     | `{ latitude: 40.066, longitude: -105.287, timeStamp: "..." }` |
| `gnssAltitude`    | Float      | `1695.9`                                                      |
| `gnssSpeed`       | Int        | `0` (GPS speed)                                               |
| `gnssBearing`     | Float      | `-10.393` (GPS heading, degrees; can be negative)             |

## Battery & Range

| Property                     | Value type | Example                                              |
| ---------------------------- | ---------- | ---------------------------------------------------- |
| `batteryLevel`               | Float      | `48.600002` (%, may have float noise)                |
| `batteryLimit`               | Int        | `85` (%)                                             |
| `batteryCapacity`            | Float      | `143.554993`                                         |
| `batteryCellType`            | String     | `"53g"` (chemistry/cell pack identifier)             |
| `batteryNeedsLfpCalibration` | Int        | `0` (`1` when an LFP 100% calibration charge is due) |
| `distanceToEmpty`            | Int        | `300` (user's distance unit)                         |
| `vehicleMileage`             | Int        | `47393698` (**meters** - divide by 1000 for km)      |
| `powerState`                 | String     | `"sleep"`, `"ready"`, `"go"`                         |
| `timeToEndOfCharge`          | Int        | `45` (minutes, `0` when not charging)                |
| `remoteChargingAvailable`    | Int        | `0` or `1`                                           |
| `rangeThreshold`             | String     | `"vehicle_range_normal"`, `"vehicle_range_low"`      |

## Charging

| Property                          | Value type | Example                                                                                        |
| --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `chargerStatus`                   | String     | `"chrgr_sts_not_connected"`, `"chrgr_sts_connected_no_chrg"`, `"chrgr_sts_connected_charging"` |
| `chargerState`                    | String     | `"charging_ready"`, `"charging_active"`, `"charging_stopped"`                                  |
| `chargePortState`                 | String     | `"close"`, `"open"`, `"Locked"`                                                                |
| `chargerDerateStatus`             | String     | `"NONE"` (derate info during charging)                                                         |
| `chargingTimeEstimationValidity`  | String     | `"SNA"` when idle; also `"SNA"` during a live charge on Oct 10, 2026                           |
| `chargingDisabledAC`              | Int        | `0` = AC charging allowed (added Oct 2026)                                                     |
| `chargingDisabledAll`             | Int        | `0` = charging allowed (added Oct 2026)                                                        |
| `closureChargePortDoorNextAction` | String     | `"open_not_available"` (added Oct 2026)                                                        |

## OTA Software

| Property                     | Value type | Example                                                                                                                                                       |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otaCurrentVersion`          | String     | `"2026.03.0"`                                                                                                                                                 |
| `otaCurrentVersionGitHash`   | String     | `"61f1eaca"`                                                                                                                                                  |
| `otaCurrentVersionYear`      | Int        | `2026`                                                                                                                                                        |
| `otaCurrentVersionWeek`      | Int        | `3`                                                                                                                                                           |
| `otaCurrentVersionNumber`    | Int        | `0`                                                                                                                                                           |
| `otaAvailableVersion`        | String     | `"2026.07.0"` - `"0.0.0"` means no update                                                                                                                     |
| `otaAvailableVersionGitHash` | String     | empty string when no update                                                                                                                                   |
| `otaAvailableVersionYear`    | Int        | `0` when no update available                                                                                                                                  |
| `otaAvailableVersionWeek`    | Int        | `0` when no update available                                                                                                                                  |
| `otaAvailableVersionNumber`  | Int        | `0` when no update available                                                                                                                                  |
| `otaStatus`                  | String     | `"Idle"`, `"Available"`, `"Ready_To_Install"`, `"Scheduled_To_Install"`, `"Install_Countdown"`, `"Awaiting_Install"`, `"Installing"`, `"Success"`, `"Failed"` |
| `otaCurrentStatus`           | String     | `"Install_Success"`, install state detail                                                                                                                     |
| `otaInstallReady`            | String     | `"ota_not_available"`, `"Ready"`                                                                                                                              |
| `otaInstallProgress`         | Int        | `0`–`100` (%)                                                                                                                                                 |
| `otaDownloadProgress`        | Int        | `0`–`100` (%)                                                                                                                                                 |
| `otaInstallType`             | String     | `"Convenience"`, `"FOTA"`                                                                                                                                     |
| `otaInstallDuration`         | Int        | minutes; `0` when idle                                                                                                                                        |
| `otaInstallTime`             | Int        | scheduled install time; `0` when idle                                                                                                                         |

## Drive

| Property      | Value type | Example                                                                                                                                                                         |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driveMode`   | String     | `"everyday"`, `"sport"`, `"distance"`, `"all_purpose"`, `"winter"`, `"off_road_auto"`, `"off_road_rocks"`, `"off_road_sport_auto"`, `"off_road_sport_drift"`, `"off_road_sand"` |
| `gearStatus`  | String     | `"park"`, `"drive"`, `"reverse"`, `"neutral"`                                                                                                                                   |
| `serviceMode` | String     | `"off"`, `"on"`                                                                                                                                                                 |
| `carWashMode` | String     | `"off"`, `"on"`                                                                                                                                                                 |

## Tires

| Property                            | Value type | Example                               |
| ----------------------------------- | ---------- | ------------------------------------- |
| `tirePressureStatusFrontLeft`       | String     | `"OK"`, `"Low"`, `"Critical"`         |
| `tirePressureStatusFrontRight`      | String     |                                       |
| `tirePressureStatusRearLeft`        | String     |                                       |
| `tirePressureStatusRearRight`       | String     |                                       |
| `tirePressureStatusValidFrontLeft`  | String     | validity flag; `null` when no reading |
| `tirePressureStatusValidFrontRight` | String     |                                       |
| `tirePressureStatusValidRearLeft`   | String     |                                       |
| `tirePressureStatusValidRearRight`  | String     |                                       |

> Note the name: `tirePressureStatusValid*` (with `Status`), **not** `tirePressureValid*` - the latter is rejected.

## Doors

| Property               | Example values            |
| ---------------------- | ------------------------- |
| `doorFrontLeftClosed`  | `"closed"` / `"open"`     |
| `doorFrontRightClosed` |                           |
| `doorRearLeftClosed`   |                           |
| `doorRearRightClosed`  |                           |
| `doorFrontLeftLocked`  | `"locked"` / `"unlocked"` |
| `doorFrontRightLocked` |                           |
| `doorRearLeftLocked`   |                           |
| `doorRearRightLocked`  |                           |

## Closures

| Property                        | Example values                       |
| ------------------------------- | ------------------------------------ |
| `closureFrunkClosed`            | `"closed"` / `"open"`                |
| `closureFrunkLocked`            | `"locked"` / `"unlocked"`            |
| `closureFrunkNextAction`        | `"Open_Allowed"`, `"SNA"`            |
| `closureLiftgateClosed`         |                                      |
| `closureLiftgateLocked`         |                                      |
| `closureLiftgateNextAction`     | `"Open_Allowed"`, `"SNA"`            |
| `closureTailgateClosed`         | `"signal_not_available"` when N/A    |
| `closureTailgateLocked`         |                                      |
| `closureTailgateNextAction`     | `"SNA"` (signal not available)       |
| `closureTonneauClosed`          | `"signal_not_available"` when N/A    |
| `closureTonneauLocked`          |                                      |
| `closureTonneauNextAction`      | `"SNA"`                              |
| `closureSideBinLeftClosed`      | `"closed"`, `"signal_not_available"` |
| `closureSideBinLeftLocked`      | `"locked"` / `"unlocked"`            |
| `closureSideBinRightClosed`     |                                      |
| `closureSideBinRightLocked`     |                                      |
| `closureSideBinLeftNextAction`  | `"SNA"` (added Oct 2026)             |
| `closureSideBinRightNextAction` | `"SNA"` (added Oct 2026)             |

## Windows

| Property                     | Example values                          |
| ---------------------------- | --------------------------------------- |
| `windowFrontLeftClosed`      | `"closed"` / `"open"`                   |
| `windowFrontRightClosed`     |                                         |
| `windowRearLeftClosed`       |                                         |
| `windowRearRightClosed`      |                                         |
| `windowFrontLeftCalibrated`  | `"Calibrated"`                          |
| `windowFrontRightCalibrated` |                                         |
| `windowRearLeftCalibrated`   |                                         |
| `windowRearRightCalibrated`  |                                         |
| `windowsNextAction`          | `"Open_not_available"` (added Oct 2026) |

## Climate

| Property                          | Value type | Example                           |
| --------------------------------- | ---------- | --------------------------------- |
| `cabinClimateInteriorTemperature` | Float      | `19` (actual cabin temp)          |
| `cabinClimateDriverTemperature`   | Float      | `24` (driver setpoint)            |
| `cabinPreconditioningStatus`      | String     | `"undefined"` (= off), `"active"` |
| `cabinPreconditioningType`        | String     | `"NONE"`, `"AWAY"`                |
| `defrostDefogStatus`              | String     | `"Off"`, `"On"`                   |
| `petModeStatus`                   | String     | `"Off"`, `"Disabled"`             |
| `petModeTemperatureStatus`        | String     | `"Default"`                       |

## Seat Heat & Vent

| Property                | Value type | Example                                |
| ----------------------- | ---------- | -------------------------------------- |
| `seatFrontLeftHeat`     | String     | `"Off"`, `"Low"`, `"Medium"`, `"High"` |
| `seatFrontRightHeat`    | String     |                                        |
| `seatRearLeftHeat`      | String     |                                        |
| `seatRearRightHeat`     | String     |                                        |
| `seatThirdRowLeftHeat`  | String     |                                        |
| `seatThirdRowRightHeat` | String     |                                        |
| `seatFrontLeftVent`     | String     | `"Off"`, `"Low"`, `"Medium"`, `"High"` |
| `seatFrontRightVent`    | String     |                                        |
| `steeringWheelHeat`     | String     | `"Off"`, `"On"`                        |

## Security

| Property                      | Value type | Example                                        |
| ----------------------------- | ---------- | ---------------------------------------------- |
| `gearGuardLocked`             | String     | `"locked"` / `"unlocked"`                      |
| `gearGuardVideoStatus`        | String     | `"Enabled"`, `"Disabled"`, `"Engaged"`         |
| `gearGuardVideoMode`          | String     | `"Away_From_Home"`, `"Parked"`, `"Everywhere"` |
| `gearGuardVideoTermsAccepted` | String     | `"true"` / `"false"`                           |
| `alarmSoundStatus`            | String     | `"false"` (not active), `"true"` (active)      |

## Vehicle Health

| Property                           | Value type | Example                       |
| ---------------------------------- | ---------- | ----------------------------- |
| `batteryHvThermalEvent`            | String     | `"off"`                       |
| `batteryHvThermalEventPropagation` | String     | `"nominal"`                   |
| `twelveVoltBatteryHealth`          | String     | `"NORMAL_OPERATION"`          |
| `wiperFluidState`                  | String     | `"normal"`                    |
| `brakeFluidLow`                    | null       | `null` (not triggered)        |
| `limitedAccelCold`                 | Int        | `0` (% limited, `0` = normal) |
| `limitedRegenCold`                 | Int        | `0` (% limited, `0` = normal) |

## Towing

| Property          | Value type | Example                                      |
| ----------------- | ---------- | -------------------------------------------- |
| `trailerStatus`   | String     | `"TRAILER_NOT_PRESENT"`, `"TRAILER_PRESENT"` |
| `rearHitchStatus` | String     | `"NONE"`                                     |

## Hardware Failure Status

`btmOcHardwareFailureStatus` returns `"dtc_not_set"` when healthy (added Oct 2026, in the default set). The others exist but return `null` under normal conditions:

- `btmFfHardwareFailureStatus`
- `btmIcHardwareFailureStatus`
- `btmLfdHardwareFailureStatus`
- `btmRfHardwareFailureStatus`
- `btmRfdHardwareFailureStatus`

## Supported Features Query

`SupportedFeatures` can be queried via `vehicleState(id:).supportedFeatures { name status }`. Returns feature flags like:
`ACTV_USR`, `AUTONOMY_PLUS`, `CAR_WASH_MODE`, `CHARG_PORT_DOOR_COMMAND`, `SMART_CHARG`, `HEATED_SEATS_THIRD`, `LIFTGATE_CMD`, `PET_MODE_LOW_TEMP`, `SCHED_DPRT`, `SCHED_OTA`, `TESLA_NACS`, `TRAILER_STATUS`, `TRIP_PLANNER_TRAILERS`, `WINDOWS_CMD`, etc.

Seen Oct 2026 (2025 R1S): `ACTIVE_TRIP`, `AUTO_VENT`, `CHARG_DATA_PX`, `CHARG_NTW_EA`, `CHARG_NTW_IONNA`, `CHARG_CLEAN_NRG`, `CHARG_TRIP_TARGET`, `CLM_HOLD`, `ENRG_CLD_WTHR`, `ENRG_MONTR_ACTIVE`, `ENRG_MONTR_PARK`, `LIVE_CAM`, `MOTION_CAM`, `VIDEO_DOWNLOADING`, `KEY_PAAK`, `MOBILE_WHEEL_SWAP`, `PIN_KEY_DRIVE`, `PVS_*_CMD` / `PVS_*_ST8`, `RVA`, `SD_CHARG_ENDS_AT`, `TWO_FACTOR_DRIVE`, `VEHICLE_CONNECTIVITY_PARALLAX`.

---

## Live Charging Session (`getLiveSessionHistory`)

`getLiveSessionData` no longer exists (rejected Oct 2026: `Did you mean "getLiveSessionHistory"`). Its fields moved to `getLiveSessionHistory(vehicleId: ID!)` on the charging endpoint. When not charging, every field is `null` and `chartData` is `[]`. The same all-null shape came back during an active charge on Oct 10, 2026 (vehicle state: `chargerState: charging_active`, `chargerStatus: chrgr_sts_connected_charging`). 926 of this account's 962 history sessions have no charger data (`vendor`, `isHomeCharger`, `isPublic` all `null`). Not verified: whether the query fills in during a Rivian Adventure Network or other network session.

Record fields (`FloatValueRecord` / `StringValueRecord`) use `{ value updatedAt }`.

| Field                                                                   | Type              | Notes                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `soc`                                                                   | FloatValueRecord  | Battery %                                                                                                                                                                                       |
| `power`                                                                 | FloatValueRecord  | kW                                                                                                                                                                                              |
| `current`                                                               | FloatValueRecord  | Amps                                                                                                                                                                                            |
| `rangeAddedThisSession`                                                 | FloatValueRecord  | unit unverified                                                                                                                                                                                 |
| `currentMiles`                                                          | FloatValueRecord  |                                                                                                                                                                                                 |
| `kilometersChargedPerHour`                                              | FloatValueRecord  |                                                                                                                                                                                                 |
| `totalChargedEnergy`                                                    | FloatValueRecord  | kWh                                                                                                                                                                                             |
| `timeRemaining`                                                         | StringValueRecord | was Float on `getLiveSessionData`                                                                                                                                                               |
| `timeReady`                                                             | StringValueRecord | new                                                                                                                                                                                             |
| `vehicleChargerState`                                                   | StringValueRecord |                                                                                                                                                                                                 |
| `timeElapsed`                                                           | String            |                                                                                                                                                                                                 |
| `startTime`                                                             | scalar            |                                                                                                                                                                                                 |
| `currentPrice`                                                          | scalar            | cost so far                                                                                                                                                                                     |
| `currentCurrency`                                                       | String            |                                                                                                                                                                                                 |
| `isFreeSession`                                                         | Boolean           |                                                                                                                                                                                                 |
| `isRivianCharger`                                                       | Boolean           |                                                                                                                                                                                                 |
| `derateState`                                                           | scalar            | new                                                                                                                                                                                             |
| `transactionId`, `chargerId`, `locationId`, `vehicleId`, `serialNumber` | String            |                                                                                                                                                                                                 |
| `location`                                                              | Location          | `{ id name type city address country postalCode operator { name } coordinates { latitude longitude } }`. Suggestions also list `evses images placesId directions siteLocation owner` (unprobed) |
| `chartData`                                                             | [ChartDataPoint]  | `{ time startTime endTime kw kwh soc miles vehicleChargerMode }`                                                                                                                                |

I have not verified populated values. No session was active during the Oct 2026 probe.

## Charging History (`getCompletedSessionSummariesV2`)

The v1 `getCompletedSessionSummaries` still validates but returns `[]` (Oct 2026). Use V2:

```graphql
query getCompletedSessionSummariesV2($vehicleId: String!, $pageSize: Int, $searchAfter: String) {
  getCompletedSessionSummariesV2(
    vehicleId: $vehicleId
    pageSize: $pageSize
    searchAfter: $searchAfter
  ) {
    items {
      transactionId
      vehicleId
      vehicleName
      startDateTime
      endDateTime
      totalEnergy
      rangeAdded
      charger {
        name
        type
        vendor
        isPublic
        isHomeCharger
        isRoamingNetwork
        address {
          line1
          city
          state
          country
          postalCode
          coordinates {
            __typename
          }
        }
      }
      order {
        orderId
        currencyCode
        subtotal
        totalCost
        totalDiscount
        totalTaxes
        paidTotal
        lineItems {
          itemDescription
          unitPrice
          volume
          subtotal
          taxTotal
          total
        }
        paymentMethod {
          type
        }
      }
      meta {
        dataSources
      }
    }
    pageInfo {
      nextCursor
      hasNextPage
    }
  }
}
```

- Arguments: `vehicleId: String!` (required), `pageSize: Int` (default 25, max 100; 101 returns `BAD_USER_INPUT Invalid pageSize`), `searchAfter: String` (pass `pageInfo.nextCursor`), `startDate: String`, `endDate: String`. Dates accept `YYYY-MM-DD` or ISO timestamps.
- `totalEnergy` is kWh. `rangeAdded` reads as km (47 for 12.7 kWh on an R1S).
- `charger` is `null` for home sessions. `order` is `null` unless the session was billed. `charger.type` was `"UNKNOWN"` on every public session seen.
- `paymentMethod.card` (`ChargingSessionDetailsOrderPaymentMethodCardV2`) exists. I did not query it.
- History reaches back to delivery: 961 sessions from July 31, 2024.
- Also suggested and unprobed: `taxes tariffId taxCode discounts sku` on `LineItemV2`, and `payer` on `order`.

## Charging Schedule Fields (`chargingSchedules`)

| Field       | Notes                                     |
| ----------- | ----------------------------------------- |
| `startTime` | Minutes from midnight - `1320` = 10:00 PM |
| `duration`  | Minutes - `360` = 6 hours                 |
| `amperage`  | Int                                       |
| `enabled`   | Boolean                                   |
| `weekDays`  | Array of day strings                      |
| `location`  | `{ latitude, longitude }`                 |

---

## Vehicle and User Fields (gateway, verified Oct 2026)

| Field                                                                       | Example                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Vehicle.actualGeneralAssemblyDate`                                         | `"2024-07-30"`                                                |
| `Vehicle.expectedGeneralAssemblyStartDate`                                  | `null` after build                                            |
| `Vehicle.mobileConfiguration.trimOption`                                    | `{ optionId: "BLD-DR1S", optionName: "R1S Dual" }`            |
| `Vehicle.mobileConfiguration.driveSystemOption`                             | `"Dual-motor AWD"`                                            |
| `Vehicle.mobileConfiguration.exteriorColorOption`                           | `"Glacier White paint"`                                       |
| `Vehicle.mobileConfiguration.interiorColorOption`                           | `"Black Mountain + Dark Ash Wood"`                            |
| `Vehicle.mobileConfiguration.wheelOption`                                   | `'20" All Season'` (not in upstream schema)                   |
| `Vehicle.estimatedRange(startSoc: Float!)`                                  | `491.796` at 80%; same unit as `distanceToEmpty` (unverified) |
| `Vehicle.otaEarlyAccessStatus`                                              | Boolean `false` (not a string)                                |
| `UserVehicle.owner`                                                         | owner user id                                                 |
| `UserVehicle.settings { name { value } }`                                   | vehicle name (on `UserVehicle`; rejected on `Vehicle`)        |
| `User.phones`, `User.pendingInvites`, `User.enrolledPhones`, `User.address` | exist; personal data, not rendered                            |
| `getVehicleMobileImages` / `getVehicleOrderMobileImages`                    | valid; return `[]` (array) with or without args               |

Rejected on `Vehicle`: `settings`, `departureSchedules`, `connectedProducts`, `vas`, `warranty`, `recalls`, `serviceAppointments`, `trimName`, `images`, `mobileImages`.

Rejected `mobileConfiguration` options: `batteryOption`, `batteryPackOption`, `packOption`, `roofOption`, `glassRoofOption`, `seatingOption`, `thirdRowOption`, `towingOption`, `audioOption`, `tireOption`, `autonomyOption`, `modelOption`, `packageOption`, `rangeOption`, `wheelsOption`, `interiorOption`, `exteriorOption`.

Rejected on `User`: `userId`, `locale`, `preferences`, `orders`.

---

## Additional Queries (not yet implemented)

### Confirmed working (verified Oct 2026)

**`getRegisteredWallboxes`** (charging endpoint). No parameters. Returns `[]` when none are linked. `WallboxRecord` fields: `wallboxId userId wifiId serialNumber softwareVersion model linked latitude longitude name maxAmps maxVoltage maxPower chargingStatus currentVoltage currentAmps power`.

**`getWallboxStatus`** (charging endpoint). Validates with no arguments. Returns `NOT_FOUND Wallbox not found` without a linked wallbox.

**`getSessionStatusByVehicleId(vehicleId: ID!)`** (charging endpoint). Returns `SessionStartResponse` for the last charge-start job: `id sessionId status chargerId locationId evseId userId errorId authDateTime createdTime lastUpdatedTime location`. Live value: `status: "Accepted"` for an Aug 12, 2026 Rivian Adventure Network session. `getSessionStatus(jobId: ID!)` validates but returns `FORBIDDEN 403: Forbidden`, even for this account's own job id.

**`chargepoint { getStatus { status redirectUrl } }`** (charging endpoint). Returns `status: null` for an account with no ChargePoint link.

**`payment { getPaymentMethods { default card { ... } } }`** (charging endpoint). Returned `[]` for this account. Card fields not queried.

**`cloudConnection` last-sync**: `vehicleState(id:).cloudConnection { lastSync isOnline }` covers the "GetVehicleLastConnection" use case.

### Removed from the charging endpoint (Oct 2026)

`getLiveSessionData` (moved to `getLiveSessionHistory`), `getSessionHistory`, `getWallChargerHistory`, `getNonRivianUserSession` and `getLinkedEmailForRivianId` all return `Cannot query field`.

### Untested (from external docs)

**Gateway endpoint (`/gateway/graphql`):**

- `GetEstimatedRange(soc, driveMode, trailerProfile)`: estimate range (see `Vehicle.estimatedRange` above)
- `planTrip` / `planTripWithMultiStop`: trip planning with charging stops. `planTrip` with the upstream argument shape (`origin`, `destination`, `bearing`, `vehicleId`, `startingSoc`, `startingRangeMeters`) fails gateway validation (Oct 2026). The gateway hides why.
- `places`: place search (Google Places integration)

**Charging endpoint (`/chrg/user/graphql`):**

- `ChargerDetails(id)`: DC charging station details
- `CheckByRivianId`: linked third-party charging accounts

**Orders endpoint (`/orders/graphql`):** `vehicleOrders`, `searchOrders`, `delivery`, `financeSummary`

---

## Subscriptions (websocket)

Verified live on Oct 9, 2026 (2025 R1S, 2026.31.0, parked) with read-only subscriptions. The topic list and the GNSS field map came from a separate "drive data audit" session, which read bretterer/rivian-python-client and blike/rivianmate (incl. PR #15). The Worker recorder now uses `VehicleState` and `ParallaxMessages` subscriptions (`worker/src/recorder.ts`); this section preserves the dated discovery evidence.

- **URL:** `wss://api.rivian.com/gql-consumer-subscriptions/graphql`, subprotocol `graphql-transport-ws`. No custom headers needed.
- **connection_init:** `{"type":"connection_init","payload":{"client-name":"com.rivian.ios.consumer-apollo-ios","client-version":"1.13.0-1494","dc-cid":"m-ios-<uuid4>","u-sess":"<userSessionToken>"}}` returns `connection_ack`. Then send `{"id":"<uuid>","type":"subscribe","payload":{operationName,query,variables}}`. Data arrives as `next` messages. Each subscription sends its current value at once, then pushes changes.
- **Subscription limit:** a second `VehicleState` subscription for the same `vehicleID` can fail with `BAD_REQUEST_ERROR` / `SUBSCRIPTION_LIMIT_EXCEEDED` ("Subscription with given values already exists"). 3 of 10 parallel `VehicleState` subscriptions on one connection succeeded. Put all fields in one `VehicleState` subscription per vehicle. 25 parallel `ParallaxMessages` subscriptions (one topic each) all succeeded.

### `VehicleState`

`subscription VehicleState($vehicleID: String!) { vehicleState(id: $vehicleID) { ... } }` accepts the HTTP fields plus the subscription-only ones. HTTP rejects the subscription-only fields.

| Subscription-only field                               | Value (Oct 2026)                                       |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `activeDriverName`                                    | `{ timeStamp, value }`, the driver profile name        |
| `chargingDisabledACFaultState`                        | `0`                                                    |
| `chargingTripTargetSoc`                               | `0` (no trip target)                                   |
| `chargingTripTargetMinsRemaining`                     | `65535` (looks like a "not set" value; unverified)     |
| `coldRangeNotification`                               | `"range_normal"`                                       |
| `tirePressureFrontLeft/FrontRight/RearLeft/RearRight` | `null` with `{ timeStamp value }` (validates, no data) |

Upstream also lists `closureChargePortDoorNextAction` and `chargingTimeEstimationValidity` as subscription-only. Both work over HTTP and over the subscription.

### `ParallaxMessages`

`subscription ParallaxMessages($vehicleId: String!, $rvms: [String!]) { parallaxMessages(vehicleId: $vehicleId, rvms: $rvms) { payload timestamp rvm } }`

- `payload` is base64 protobuf. `timestamp` is epoch ms and shows when the vehicle last published that topic (can be weeks old).
- Gate it on the `VEHICLE_CONNECTIVITY_PARALLAX` supported feature (`AVAILABLE` on the R1S).
- Every topic below returned one message right away. "Matches" means the value equals an HTTP `vehicleState` field read at the same time. Those field meanings are inferred, not confirmed by a schema.

| RVM topic                                                | Bytes | Fields seen                                                    | Notes                                                                                                             |
| -------------------------------------------------------- | ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `dynamics.vehicle.gnss`                                  | 59    | 1 d, 2 d, 3 d, 5 f, 6 f, 7 f, 8 f, 9 f, 10 varint              | 1 lat, 2 long, 3 altitude m, 5 bearing deg, 6 speed m/s; 7-9 unknown; 10 likely GPS-epoch ms (add `315964800000`) |
| `dynamics.vehicle.odometer`                              | 4     | 1 varint = `59059`                                             | km; matches `vehicleMileage` 59059421 m                                                                           |
| `dynamics.tires.state`                                   | 98    | 1 varint, 2 × 4 nested (22 bytes each)                         | one nested message per tire; not decoded                                                                          |
| `vehicle.power.state`                                    | 2     | 1 varint = `3`                                                 | 1 sleep, 2 standby, 3 ready, 4 go; matches `powerState` `"ready"`                                                 |
| `navigation.navigation_service.trip_info`                | 0     | empty                                                          | no active navigation                                                                                              |
| `navigation.navigation_service.trip_progress`            | 73    | 1 bytes, 2 bytes, 4 d = 57, 5 d = 9, 6 bytes                   | not empty without navigation (last trip?); not decoded                                                            |
| `body.closures.states`                                   | 133   | 16 × nested field 1                                            | one entry per closure; not decoded                                                                                |
| `body.locks.states`                                      | 66    | 11 × nested field 1                                            | not decoded                                                                                                       |
| `comfort.cabin.cabin_preconditioning_status`             | 0     | empty                                                          | preconditioning off                                                                                               |
| `comfort.cabin.cabin_temperatures`                       | 10    | 3 f = 24, 4 f = 22                                             | likely driver setpoint and cabin temp (°C)                                                                        |
| `comfort.cabin.defrost_defog_status`                     | 2     | 1 varint = `4`                                                 | enum; meaning unknown                                                                                             |
| `energy.high_voltage.battery_state`                      | 22    | 1 nested (18), 3 empty                                         | not decoded                                                                                                       |
| `energy.high_voltage.battery_characteristics`            | 10    | 5 f = 142.235, 6 f = 141.6                                     | 5 matches `batteryCapacity` (kWh)                                                                                 |
| `energy_edge_compute.graphs.charging_graph_global`       | 574   | 23 × nested field 1                                            | last charge curve samples; not decoded                                                                            |
| `energy_edge_compute.graphs.charge_session_breakdown`    | 25    | 1 f = 0.9, 2 f = 0.7, 5 f = 0.2, 6 = 43, 8 = 2, 12 = 1, 13 = 1 | 1 matches the last session's `totalEnergy` (0.9 kWh)                                                              |
| `energy_edge_compute.graphs.cold_weather_soc`            | 2     | 1 varint = `34`                                                | close to `batteryLevel` 33.8                                                                                      |
| `energy_edge_compute.graphs.parked_energy_distributions` | 94    | 3 nested                                                       | not decoded                                                                                                       |
| `charging.session.status`                                | 4     | 1 = 1, 2 = 1                                                   | enum; not decoded                                                                                                 |
| `charging.session.time_estimation`                       | 0     | empty                                                          | not charging                                                                                                      |
| `charging.session.trip_target`                           | 4     | 2 varint = `65535`                                             | matches `chargingTripTargetMinsRemaining`                                                                         |
| `charging.session.soc_slider`                            | 2     | 1 varint = `85`                                                | likely the charge limit %                                                                                         |
| `charging.session.notification`                          | 2     | 1 = 1                                                          | not decoded                                                                                                       |
| `charging.session.remote_command`                        | 2     | 1 = 1                                                          | state of the last remote charge command; subscribing sends nothing                                                |
| `charging.schedule.time_window`                          | 0     | empty                                                          |                                                                                                                   |
| `vehicle.network.state`                                  | 77    | 1 = 2, 2 × 4 nested, 3 = 2, 4 bytes, 5 bytes                   | not decoded                                                                                                       |

### `chargingSession` and `vehicleDepartureSchedules`

Both return data (bodies from rivianmate `server/src/rivian/graphql.ts`).

- `subscription chargingSession($vehicleID: String!) { chargingSession(vehicleId: $vehicleID) { chartData { soc powerKW startTime endTime timeEstimationValidityStatus vehicleChargerState } liveData { powerKW kilometersChargedPerHour rangeAddedThisSession totalChargedEnergy timeElapsed timeRemaining price currency isFreeSession vehicleChargerState startTime } } }`. When not charging, it returns `chartData: []` and all-null `liveData`. It returned the same during the active charge on Oct 10, 2026, with no update within 25 s.
- `subscription vehicleDepartureSchedules($vehicleID: String!) { vehicleDepartureSchedules(vehicleId: $vehicleID) { id name isEnabled occurrence { __typename ... on RepeatsWeekly { days startsAtMin } } departureSettings { comfortSettings { surfaceHeatVentLevels { frontLeftSeat frontRightSeat } cabinTempCelsius frontDefogDefrost } } } }`. Returns the saved departure schedules, for example `{ name: "Schedule 1", isEnabled: false, occurrence: { days: [Mon..Fri], startsAtMin: 735 }, ... cabinTempCelsius: 23 }`. HTTP rejects `Vehicle.departureSchedules`, so this subscription is the only read path found.

### Drive and trip history

- No server-side drive history query is known.
- Rejected on the gateway without arguments: `getTrips`, `trips`, `tripHistory`, `driveHistory`, `getDrives`, `drives`, `getTripSummaries`, `tripSummaries`, `getDriveSessions`. A field that needs arguments would also fail that probe.
- `getSavedTrips` is valid and returns `[]` (trip planning).
- Third-party tools build drive logs by staying subscribed.
- RivianMate issue #14: on a 2027 R2 (2026.31.40), `gnssLocation` and `activeDriverName` fail validation over the subscription. On the R1S, both validate, so that failure is specific to the R2 or its firmware.

---

## Fields and queries rejected in testing

These probes returned `GRAPHQL_VALIDATION_FAILED`. Do not add them without verifying a working query:

**Vehicle state:** `vehicleSpeed`, `suspensionLevel`, `rideHeight`, `kineticRoll`, `pitchAngle`, `batteryAuxLevel`, `chargerVoltage`, `chargerCurrent`, `regenBrakingMode`, `odometer`, `tripMileage`, `towMode`, `campMode`, `differentialLockFront/Rear`, `seatVentFrontLeft/Right` (wrong name - use `seatFrontLeftVent`), `tirePressureFrontLeft` (wrong - use `tirePressureStatusFrontLeft`), `tirePressureValidFrontLeft/Right/RearLeft/Right`, `doorFrontLeft/Right/RearLeft/RightNextAction`

**Gateway queries:** `planTrip` (via our query format - may need different operation name), `getNearbyChargingSites`, `getVehicleImages` (rejected in our tests), `getVehicleWarranty`, `getUserNotifications`, `getVehicleOrderStatus`

**Charging queries:** `getChargingSiteDetails`, `getActiveChargingSession`, `getPricingInfo`, `getChargerSummary`, `getNearbyChargingStations`, `getRoamingChargingNetworks`

**Probed July 2026, rejected (vehicle state):** `seatRearLeftVent`, `seatRearRightVent`, `seatThirdRowLeftVent`, `seatThirdRowRightVent` (only `seatFrontLeftVent`/`seatFrontRightVent` exist), `gnssHorizontalAccuracy`, `gnssVerticalAccuracy`, `batteryLevelRaw`, `usableBatteryLevel`, `stateOfChargeLimit`, `chargerCablePresent`, `chargePortNextAction`, `driveModeEndTime`, `windowFrontLeftNextAction`, `windowCalibrationStatus`, `gearGuardAlarmStatus`, `tirePressureFrontLeftValid`, `brakePadWearFrontLeft`, `currentAddress`, `nextChargeTarget`, `lifetimeEnergyUsed`, `chargeEndReason`, `chargerType`, `acChargingPower`, `dcChargingPower`, `batteryHeatingStatus`, `preconditioningStatus`, `thermalWarning`, `centerDisplayStatus`, `driverPresence`, `liftgateNextAction` (use `closureLiftgateNextAction`), `estimatedTimeToEndOfCharge` (use `timeToEndOfCharge`)

**Probed Oct 2026, rejected (vehicle state, HTTP):** `chargingDisabledACFaultState`, `chargingTripTargetMinsRemaining`, `chargingTripTargetSoc`, `coldRangeNotification`, `activeDriverName`, `tirePressureFrontLeft` (these are subscription-only upstream), `tirePressureFrontLeftBar/Psi/Kpa`, `chargeTargetSoc`, `chargingMode`, `chargePortDoorState`, `closureChargePortDoorClosed/Locked`, `cabinClimateExteriorTemperature`, `cabinClimatePassengerTemperature`, `exteriorTemperature`, `ambientTemperature`, `outsideTemperature`, `batteryTemperature`, `batteryHvTemperature`, `batteryStateOfHealth`, `batteryHealth`, `batteryDegradation`, `rangeEstimate`, `gearGuardLiveStatus`, `gearGuardAutoRecord`, `autonomyStatus`, `driverAssistStatus`, `highwayAssistStatus`, `softwareUpdateStatus`, `sentryMode`, `campModeStatus`, `kneelStatus`, `suspensionHeight`, `rideHeightStatus`, `speed`, `odometerKm`, `chargeLimit`, `batteryLimitMax`, `departureTime`, `departureScheduleStatus`, `preconditioningTargetTemperature`, `cabinClimateTargetTemperature`, `seatSecondRowLeftHeat/RightHeat`, `steeringWheelHeatLevel`, `windowsCalibrated`, `sunroofStatus`, `sunshadeStatus`, `closureSunroofClosed`, `closureGearTunnelLeftClosed/RightClosed`, `lowBeamStatus`, `headlightStatus`, `hornStatus`, `keyFobPresent`, `phoneKeyPresent`, `driverDoorAjar`, `tpmsStatus`, `chargingSessionId`, `plugStatus`, `chargerPlugType`, `evseType`, `acChargeCurrent`, `dcChargePower`, `chargePower`, `chargerPower`, `chargingPower`, `chargingRate`, `chargingSpeed`

**Probed Oct 2026, rejected (charging `Query`):** about 400 `get/list/fetch/search` + noun combinations (sessions, sites, stations, pricing, tariffs, invoices, receipts, roaming, plug-and-charge, credits, subscriptions). Those probes found only the queries listed in this document.

---

## Rivian Assistant (probed Oct 2026, not on the consumer API)

Rivian announced Rivian Assistant on 2026-05-12 as an in-car voice assistant ("Hey Rivian" or the left steering-wheel button), for Connect+ on Gen 1, Gen 2 and R2. It runs on Rivian's own "Unified Intelligence" stack. Source: https://rivian.com/stories/software-update-hey-rivian-assistant-connect-ai-2026 (not independently verified).

Four read-only probe rounds found no assistant, chat, conversation, or intelligence surface on the consumer GraphQL HTTP API. Subscriptions were not probed for assistant topics. Do not re-run blind name-guessing; capture the app or car traffic instead.

**Probe conditions:**

- Introspection is disabled on every reachable endpoint (`__schema` / `__type` return `GRAPHQL_VALIDATION_FAILED`).
- The gateway gives no "did you mean" suggestions. A misspelled field returns a generic `GRAPHQL_VALIDATION_FAILED`. Name-hint discovery does not work here.
- The gateway hides field-level detail: `{ currentUser { <missing> } }` returns the same generic error for a real-but-needs-subselection field and a nonexistent one. Only object fields can be told apart, by whether a subselection changes the error.

**Endpoint paths on `rivian.com/api/gql/` (POST `{ __typename }`):**

- Exist (200, `Query`): `gateway`, `chrg/user`, `orders`, `content`.
- Does not exist (404 marketing HTML, same as a bogus control): `trips`, and every assistant-style name tried (`assistant`, `ai`, `chat`, `rai`, `intelligence`, `conversation`, `conversations`, `ria`, `assistant/user`, `ai/user`, `support`, `service`, `notifications`).
- Inconclusive: `t2d` returned a 503 nginx page, likely a transient outage. Retry later.

**Fields:**

- `currentUser.settings` exists and exposes `distanceUnit`, `temperatureUnit` and `pressureUnit` (see the top of this file). The probe reported its type as `UserSettingsMap`; no other source in this repo confirms that name. Assistant subfields were not probed. It is the most plausible place for an assistant settings toggle on the consumer API.
- Confirmed absent on the `orders` root (its errors name the field): `assistant`, `intelligence`, `aiAssistant`.
- Inconclusive on the gateway `currentUser` (generic error, same as control): `preferences`, `assistant`, `assistantSettings`, `intelligence`, `intelligenceSettings`, `rivianIntelligence`, `aiSettings`, `aiPreferences`, `memory`, `voiceAssistant`, `features`, `enrolledFeatures`, `featureFlags`.
- Inconclusive on the `content` root (error "Invalid request.", no field detail): `assistant`, `intelligence`, `aiAssistant`, `faq`, `article`, `support`.

**Subscriptions:** not probed for assistant topics. One probe opened the same websocket (`wss://api.rivian.com/gql-consumer-subscriptions/graphql`) and `connection_init` was closed with `4400 Bad request`. That payload is not recorded here. The working `connection_init` payload (`client-name`, `client-version`, `dc-cid`, `u-sess`) is in "Subscriptions (websocket)" above and `worker/src/recorder.ts`. No subscribe was sent.

**Open question not answerable from the API:** whether the assistant transcribes speech in the car and sends text, or streams raw audio to a backend. Resolve it by capturing the Rivian app and car traffic (e.g. mitmproxy) while using an assistant feature.
