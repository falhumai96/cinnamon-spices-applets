
//----------------------------------------------------------------------
//
// Weather Applet
//
//----------------------------------------------------------------------

import { DateTime } from "luxon";
import { Config, ServiceClassMapping } from "./config";
import { WeatherLoop } from "./loop";
import { WeatherData, WeatherProvider, LocationData, AppletError, CustomIcons, NiceErrorDetail, RefreshState, BuiltinIcons } from "./types";
import { UI } from "./ui";
import { AwareDateString, CapitalizeFirstLetter, CompassDirectionText, ExtraFieldToUserUnits, GenerateLocationText, MPStoUserUnits, NotEmpty, PercentToLocale, PressToUserUnits, ProcessCondition, TempToUserConfig, UnitToUnicode, WeatherIconSafely, _ } from "./utils";
import { HttpLib, HttpError, Method, HTTPParams, HTTPHeaders, ErrorResponse, Response } from "./lib/httpLib";
import { Logger } from "./lib/logger";
import { APPLET_ICON, REFRESH_ICON } from "./consts";
import { CloseStream, OverwriteAndGetIOStream, WriteAsync } from "./lib/io_lib";
import { NotificationService } from "./lib/notification_service";
import { SpawnProcess } from "./lib/commandRunner";


const { TextIconApplet, AllowedLayout, MenuItem } = imports.ui.applet;
const { spawnCommandLine } = imports.misc.util;
const { IconType, Side } = imports.gi.St;
const { File, NetworkMonitor, NetworkConnectivity } = imports.gi.Gio;

export class WeatherApplet extends TextIconApplet {
	private readonly loop: WeatherLoop;
	private lock = false;
	private refreshTriggeredWhileLocked = false;

	/** Chosen API */
	private provider?: WeatherProvider;

	private orientation: imports.gi.St.Side;
	public get Orientation() {
		return this.orientation;
	}

	/** Running applet's path */
	public readonly AppletDir: string;
	public readonly config: Config;
	public readonly ui: UI;

	private readonly metadata: any; 

	/** Used for error handling, first error calls flips it
	 * to prevents displaying other errors in the current loop.
	 */
	public encounteredError: boolean = false;

	private online: boolean | null = null;
	private currentWeatherInfo: WeatherData | null = null;

	public constructor(metadata: any, orientation: imports.gi.St.Side, panelHeight: number, instanceId: number) {
		super(orientation, panelHeight, instanceId);
		this.metadata = metadata;
		this.AppletDir = metadata.path;
		Logger.Debug("Applet created with instanceID " + instanceId);
		Logger.Debug("AppletDir is: " + this.AppletDir);

		this.SetAppletOnPanel();
		this.config = new Config(this, instanceId);
		this.AddRefreshButton();
		this.EnsureProvider();
		this.ui = new UI(this, orientation);
		this.ui.Rebuild(this.config);
		this.loop = new WeatherLoop(this, instanceId);

		this.orientation = orientation;
		try {
			this.setAllowedLayout(AllowedLayout.BOTH);
		} catch (e) {
			// vertical panel not supported
		}
		this.loop.Start();
		this.OnNetworkConnectivityChanged();
		NetworkMonitor.get_default().connect("notify::connectivity", this.OnNetworkConnectivityChanged);
	}

	public Locked(): boolean {
		return this.lock;
	}

	private OnNetworkConnectivityChanged = () => {
		switch (NetworkMonitor.get_default().connectivity) {
			case NetworkConnectivity.FULL:
			case NetworkConnectivity.LIMITED:
			case NetworkConnectivity.PORTAL:
				if (this.online === true)
					break;
				Logger.Info("Internet access now available, resuming operations.");
				this.loop.Resume();
				this.online = true;
				break;
			case NetworkConnectivity.LOCAL:
				if (this.online === false)
					break;
				Logger.Info(`Internet access now down with "${NetworkMonitor.get_default().connectivity}", pausing refresh.`);
				this.loop.Pause();
				this.online = false;
				break;
		}
	}

	/**
	 * @returns Queues a refresh if if refresh was triggered while locked.
	 */
	public RefreshAndRebuild(this: WeatherApplet, loc?: LocationData | null): void {
		this.loop.Resume();
		if (this.Locked()) {
			this.refreshTriggeredWhileLocked = true;
			return;
		}
		this.RefreshWeather(true, loc);
	};

	/**
	 * Main function pulling and refreshing data
	 * @param rebuild 
	 */
	public async RefreshWeather(this: WeatherApplet, rebuild: boolean, location?: LocationData | null): Promise<RefreshState> {
		try {
			if (this.lock) {
				Logger.Info("Refreshing in progress, refresh skipped.");
				return RefreshState.Locked;
			}

			this.lock = true;
			this.encounteredError = false;

			if (!location) {
				location = await this.config.EnsureLocation();
				if (!location) {
					this.Unlock();
					return RefreshState.Error;
				}
			}

			this.EnsureProvider();
			if (this.provider == null)
				return RefreshState.Failure;

			// No key
			if (this.provider.needsApiKey && this.config.NoApiKey()) {
				Logger.Error("No API Key given");
				this.ShowError({
					type: "hard",
					userError: true,
					detail: "no key",
					message: _("This provider requires an API key to operate")
				});
				return RefreshState.Failure;
			}
			let weatherInfo = await this.provider.GetWeather(location);
			if (weatherInfo == null) {
				this.Unlock();
				Logger.Error("Could not refresh weather, data could not be obtained.");
				this.ShowError({
					type: "hard",
					detail: "no api response",
					message: "API did not return data"
				})
				return RefreshState.Failure;
			}

			weatherInfo = this.MergeWeatherData(weatherInfo, location);
			this.config.Timezone = weatherInfo.location.timeZone;

			if (rebuild) this.ui.Rebuild(this.config);
			if (!this.ui.Display(weatherInfo, this.config, this.provider) ||
				!this.DisplayWeather(weatherInfo)) {
				this.Unlock();
				return RefreshState.Failure;
			}

			Logger.Info("Weather Information refreshed");
			this.loop.ResetErrorCount();
			this.currentWeatherInfo = weatherInfo;
			this.Unlock();
			return RefreshState.Success;
		}
		catch (e) {
			if (e instanceof Error)
				Logger.Error("Generic Error while refreshing Weather info: " + e + ", ", e);
			this.ShowError({ type: "hard", detail: "unknown", message: _("Unexpected Error While Refreshing Weather, please see log in Looking Glass") });
			this.Unlock();
			return RefreshState.Failure;
		}
	}

	// ---------------------------------------------------------------------------
	// Panel Set helpers helpers

	/** Displays weather info in applet's panel */
	private DisplayWeather(weather: WeatherData): boolean {
		const location = GenerateLocationText(weather, this.config);

		const lastUpdatedTime = AwareDateString(weather.date, this.config.currentLocale, this.config._show24Hours, DateTime.local().zoneName);
		this.SetAppletTooltip(`${location} - ${_("As of {lastUpdatedTime}", { "lastUpdatedTime": lastUpdatedTime })}`);
		this.DisplayWeatherOnLabel(weather);
		this.SetAppletIcon(weather.condition.icons, weather.condition.customIcon);
		return true;
	}

	public RefreshLabel = () => {
		if (this.currentWeatherInfo == null)
			return;
		this.DisplayWeatherOnLabel(this.currentWeatherInfo);
	}

	private DisplayWeatherOnLabel(weather: WeatherData) {
		const temperature = weather.temperature;
		const mainCondition = CapitalizeFirstLetter(weather.condition.main);
		// Applet panel label
		let label = "";
		// Horizontal panels
		if (this.Orientation != Side.LEFT && this.Orientation != Side.RIGHT) {
			if (this.config._showCommentInPanel) {
				label += mainCondition;
			}
			if (this.config._showTextInPanel) {
				if (label != "") {
					label += " ";
				}
				label += TempToUserConfig(temperature, this.config);
			}
		}
		// Vertical panels
		else {
			if (this.config._showTextInPanel) {
				label = TempToUserConfig(temperature, this.config, false) ?? "";
				// Vertical panel width is more than this value then we has space
				// to show units
				if (this.GetPanelHeight() >= 35) {
					label += UnitToUnicode(this.config.TemperatureUnit);
				}
			}
		}

		// Overriding temperature panel label
		if (NotEmpty(this.config._tempTextOverride)) {
			label = this.config._tempTextOverride
				.replace(/{t}/g, TempToUserConfig(temperature, this.config, false) ?? "")
				.replace(/{u}/g, UnitToUnicode(this.config.TemperatureUnit))
				.replace(/{c}/g, mainCondition)
				.replace(/{c_long}/g, weather.condition.description)
				.replace(/{dew_point}/g, TempToUserConfig(weather.dewPoint, this.config, false) ?? "")
				.replace(/{humidity}/g, weather.humidity?.toString() ?? "")
				.replace(/{pressure}/g, weather.pressure != null ? PressToUserUnits(weather.pressure, this.config._pressureUnit).toString() : "")
				.replace(/{pressure_unit}/g, this.config._pressureUnit)
				.replace(/{extra_value}/g, weather.extra_field ? ExtraFieldToUserUnits(weather.extra_field, this.config) : "")
				.replace(/{extra_name}/g, weather.extra_field ? weather.extra_field.name : "")
				.replace(/{wind_speed}/g, weather.wind.speed != null ? MPStoUserUnits(weather.wind.speed, this.config.WindSpeedUnit) : "")
				.replace(/{wind_dir}/g, weather.wind.degree != null ? CompassDirectionText(weather.wind.degree) : "");
		}

		this.SetAppletLabel(label);
	}

	private SetAppletTooltip(msg: string) {
		this.set_applet_tooltip(msg);
	}

	private SetAppletIcon(iconNames: BuiltinIcons[], customIcon: CustomIcons) {
		if (this.config._useCustomAppletIcons) {
			this.SetCustomIcon(customIcon);
		}
		else {
			const icon = WeatherIconSafely(iconNames, this.config.AppletIconType);
			this.config.AppletIconType == IconType.SYMBOLIC ?
				this.set_applet_icon_symbolic_name(icon) :
				this.set_applet_icon_name(icon);
		}
	}

	private SetAppletLabel(label: string) {
		this.set_applet_label(label);
	}

	private GetPanelHeight(): number {
		return this.panel?.height ?? 0;
	}

	// ---------------------------------------------------------------------------
	// UI helpers

	public GetMaxForecastDays(): number {
		if (!this.provider) return this.config._forecastDays;
		return Math.min(this.config._forecastDays, this.provider.maxForecastSupport);
	}

	public GetMaxHourlyForecasts(): number {
		if (!this.provider) return this.config._forecastHours;
		return Math.min(this.config._forecastHours, this.provider.maxHourlyForecastSupport);
	}

	// ------------------------------------------------------------------------
	// IO Helpers

	/**
	 * Loads JSON response from specified URL, returns the whole response not just data
	 * @param url URL without params
	 * @param params param object
	 * @param HandleError should return true if you want this function to handle errors, else false
	 * @param method default is GET
	 */
	public async LoadJsonAsyncWithDetails<T, E = any>(this: WeatherApplet, url: string, params?: HTTPParams, HandleError?: (message: ErrorResponse<E>) => boolean, headers?: HTTPHeaders, method: Method = "GET"): Promise<Response<T, E>> {
		const response = await HttpLib.Instance.LoadJsonAsync<T, E>(url, params, headers, method);

		// We have errorData inside
		if (!response.Success) {
			// check if caller wants
			if (!!HandleError && !HandleError(response))
				return response;
			else {
				this.HandleHTTPError(response.ErrorData);
				return response;
			}
		}

		return response;
	}

	/**
	 * Loads JSON response from specified URLs
	 * @param url URL without params
	 * @param params param object
	 * @param HandleError should return true if you want this function to handle errors, else false
	 * @param method default is GET
	 */
	public async LoadJsonAsync<T, E = any>(this: WeatherApplet, url: string, params?: HTTPParams, HandleError?: (message: ErrorResponse<E>) => boolean, headers?: HTTPHeaders, method: Method = "GET"): Promise<T | null> {
		const response = await this.LoadJsonAsyncWithDetails<T, E>(url, params, HandleError, headers, method);
		return (response.Success) ? response.Data : null;
	}

	/**
	 * Loads response from specified URLs
	 * @param url URL without params
	 * @param params param object
	 * @param HandleError should return true if you want this function to handle errors, else false
	 * @param method default is GET
	 */
	public async LoadAsync(this: WeatherApplet, url: string, params?: HTTPParams, HandleError?: (message: HttpError) => boolean, headers?: HTTPHeaders, method: Method = "GET"): Promise<string | null> {
		const response = await HttpLib.Instance.LoadAsync(url, params, headers, method);

		// We have errorData inside
		if (!response.Success) {
			// check if caller wants
			if (!!HandleError && !HandleError(response.ErrorData))
				return null;
			else {
				this.HandleHTTPError(response.ErrorData);
				return null;
			}
		}

		return response.Data;
	}

	// ----------------------------------------------------------------------------
	// Config Callbacks, do not delete

	private async locationLookup(): Promise<void> {
		const command = "xdg-open ";
		spawnCommandLine(command + "https://cinnamon-spices.linuxmint.com/applets/view/17");
	}

	private async submitIssue(): Promise<void> {
		const command = "xdg-open";
		const baseUrl = 'https://github.com/linuxmint/cinnamon-spices-applets/issues/new';
		const title = "weather@mockturl - ";

		const distribution: string = (await SpawnProcess(["uname", "-vrosmi"]))?.Data?.trim();
		const appletVersion = this.metadata.version;
		const cinnamonVersion = imports.misc.config.PACKAGE_VERSION;
		const vgaInfo = (await SpawnProcess(["lspci"])).Data?.split("\n").filter(x => x.includes("VGA"));

		let body = "```\n";
		body+= ` * Applet version - ${appletVersion}\n`;
		body+= ` * Cinnamon version - ${cinnamonVersion}\n`;
		body+= ` * Distribution - ${distribution}\n`;
		body+= ` * Graphics hardware - ${vgaInfo.join(", ")}\n`;
		body+= "```\n\n";

		body+= `**Notify author of applet**\n@Gr3q\n\n`;

		body+= "**Issue**\n\n\n\n**Steps to reproduce**\n\n\n\n**Expected behaviour**\n\n\n\n**Other information**\n\n";

		body+= `<details>
<summary>Relevant Logs</summary>

\`\`\`
The contents of the file saved from the applet help page goes here
\`\`\`

</details>\n\n`;

		const finalUrl = `${baseUrl}?title=${encodeURI(title)}&body=${encodeURI(body)}`.replace(/[\(\)#]/g, "");
		spawnCommandLine(`${command} ${finalUrl}`);
	}

	private async saveCurrentLocation(): Promise<void> {
		this.config.LocStore.SaveCurrentLocation(this.config.CurrentLocation);
	}

	public saveLog = async(): Promise<void> => {
		// Empty string, abort
		if (!(this.config._selectedLogPath?.length > 0))
			return;

		let logLines: string[] = [];
		try {
			logLines = await Logger.GetAppletLogs();
		}
		catch(e) {
			if (e instanceof Error) {
				NotificationService.Instance.Send(_("Error Saving Debug Information"), e.message);
			}
			return;
		}

		let settings: Record<string, any> | null = null;
		try {
			settings = await this.config.GetAppletConfigJson();
		}
		catch(e) {
			if (e instanceof Error) {
				NotificationService.Instance.Send(_("Error Saving Debug Information"), e.message);
			}
		}

		const appletLogFile = File.new_for_path(this.config._selectedLogPath);
		const stream = await OverwriteAndGetIOStream(appletLogFile);
		await WriteAsync(stream.get_output_stream(), logLines.join("\n"));
		
		if (settings != null) {
			await WriteAsync(stream.get_output_stream(), "\n\n------------------- SETTINGS JSON -----------------\n\n");
			await WriteAsync(stream.get_output_stream(), JSON.stringify(settings, null, 2));
		}
		
		await CloseStream(stream.get_output_stream());
		NotificationService.Instance.Send(_("Debug Information saved successfully"), _("Saved to {filePath}", {filePath: this.config._selectedLogPath}));
	}

	// -------------------------------------------------------------------
	// Applet Overrides, do not delete

	public override on_orientation_changed(orientation: imports.gi.St.Side) {
		this.orientation = orientation;
		this.RefreshWeather(true);
	};

	public override on_applet_removed_from_panel(deleteConfig: any) {
		Logger.Info("Removing applet instance...")
		this.loop.Stop();
	}

	public override on_applet_clicked(event: any): boolean {
		this.ui.Toggle();
		return false;
	}

	public override on_applet_middle_clicked(event: any) {
		return false;
	}

	public override on_panel_height_changed() {
		// Implemented byApplets
	}

	// ---------------------------------------------------------------------
	// Utilities

	/** Set applet on the panel with default settings */
	private SetAppletOnPanel(): void {
		this.set_applet_icon_name(APPLET_ICON);
		this.set_applet_label(_("..."));
		this.set_applet_tooltip(_("Click to open"));
	}

	private Unlock(): void {
		this.lock = false;
		if (this.refreshTriggeredWhileLocked) {
			Logger.Info("Refreshing triggered by config change while refreshing, starting now...");
			this.refreshTriggeredWhileLocked = false;
			this.RefreshAndRebuild();
		}

	}

	/** Into right-click context menu */
	private AddRefreshButton(): void {
		const itemLabel = _("Refresh")
		const refreshMenuItem = new MenuItem(itemLabel, REFRESH_ICON, () => this.RefreshAndRebuild());
		this._applet_context_menu.addMenuItem(refreshMenuItem);
	}

	/**
	 * Handles general errors from HTTPLib
	 * @param error 
	 */
	private HandleHTTPError(error: HttpError): void {
		const appletError: AppletError = {
			detail: error.message,
			userError: false,
			code: error.code,
			message: this.errMsg[error.message],
			type: "soft"
		};

		switch (error.message) {
			case "bad status code":
			case "unknown":
				appletError.type = "hard"
		}

		this.ShowError(appletError);
	}

	private SetCustomIcon(iconName: CustomIcons): void {
		this.set_applet_icon_symbolic_name(iconName);
	}

	/**
	 * Lazy load provider
	 * @param force Force provider re initialization
	 */
	private EnsureProvider(force: boolean = false): void {
		const currentName = this.provider?.name;
		if (currentName != this.config._dataService || force)
			this.provider = ServiceClassMapping[this.config._dataService](this);
	}

	/** Fills in missing weather info from location Data
	 * and applies translations if needed.
	 */
	private MergeWeatherData(weatherInfo: WeatherData, locationData: LocationData) {
		if (weatherInfo.location.city == null) weatherInfo.location.city = locationData.city;
		if (weatherInfo.location.country == null) weatherInfo.location.country = locationData.country;
		if (weatherInfo.location.timeZone == null) weatherInfo.location.timeZone = locationData.timeZone;
		if (weatherInfo.coord.lat == null) weatherInfo.coord.lat = locationData.lat;
		if (weatherInfo.coord.lon == null) weatherInfo.coord.lon = locationData.lon;
		if (weatherInfo.hourlyForecasts == null) weatherInfo.hourlyForecasts = [];

		// Translate conditions if set
		weatherInfo.condition.main = ProcessCondition(weatherInfo.condition.main, this.config._translateCondition);
		weatherInfo.condition.description = ProcessCondition(weatherInfo.condition.description, this.config._translateCondition);

		for (const forecast of weatherInfo.forecasts) {
			const condition = forecast.condition;
			condition.main = ProcessCondition(condition.main, this.config._translateCondition);
			condition.description = ProcessCondition(condition.description, this.config._translateCondition);
		}

		for (const forecast of weatherInfo.hourlyForecasts) {
			const condition = forecast.condition;
			condition.main = ProcessCondition(condition.main, this.config._translateCondition);
			condition.description = ProcessCondition(condition.description, this.config._translateCondition);
		}

		return weatherInfo;
	}

	// ---------------------------------------------------------------------------------------

	// Error handling

	/** For displaying hard errors */
	private DisplayHardError(title: string, msg: string): void {
		this.set_applet_label(title);
		this.set_applet_tooltip("Click to open");
		this.set_applet_icon_name("weather-severe-alert");
		this.ui.DisplayErrorMessage(msg, "hard");
	};

	private errMsg: NiceErrorDetail = { // Error messages to use
		unknown: _("Error"),
		"bad api response - non json": _("Service Error"),
		"bad key": _("Incorrect API Key"),
		"bad api response": _("Service Error"),
		"bad location format": _("Incorrect Location Format"),
		"bad status code": _("Service Error"),
		"key blocked": _("Key Blocked"),
		"location not found": _("Can't find location"),
		"no api response": _("Service Error"),
		"no key": _("No Api Key"),
		"no location": _("No Location"),
		"no network response": _("Service Error"),
		"no response body": _("Service Error"),
		"no response data": _("Service Error"),
		"unusual payload": _("Service Error"),
		"import error": _("Missing Packages"),
		"location not covered": _("Location not covered"),
	}

	public ShowError(error: AppletError): void {
		if (error == null) return;
		// An error already claimed in this loop
		if (this.encounteredError == true) return;

		this.encounteredError = true;
		Logger.Debug("User facing Error received, error: " + JSON.stringify(error, null, 2));

		if (error.type == "hard") {
			Logger.Debug("Displaying hard error");
			this.ui.Rebuild(this.config);
			this.DisplayHardError(this.errMsg[error.detail], (!error.message) ? "" : error.message);
		}

		if (error.type == "soft") {
			// Maybe something less invasive on network related errors?
			// Nothing yet
			if (this.loop.IsDataTooOld()) {
				this.set_applet_tooltip("Click to open");
				this.set_applet_icon_name("weather-severe-alert");
				this.ui.DisplayErrorMessage(_("Could not update weather for a while...\nare you connected to the internet?"), "soft");
			}
		}

		if (error.userError) {
			Logger.Error("Error received caused by User, Pausing main loop.");
			this.loop.Pause();
			return;
		}

		const nextRefresh = this.loop.GetSecondsUntilNextRefresh();
		Logger.Error("Retrying in the next " + nextRefresh.toString() + " seconds...");
	}

	//----------------------------------------------------------------------------------
}