/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import * as zrUtil from 'zrender/src/core/util';
import * as layout from '../../util/layout';
import * as numberUtil from '../../util/number';
import BoundingRect, { RectLike } from 'zrender/src/core/BoundingRect';
import CalendarModel from './CalendarModel';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import SeriesModel from '../../model/Series';
import {
    LayoutOrient,
    ScaleDataValue,
    OptionDataValueDate,
    CoordinateSystemDataLayout,
    ZRRectLike,
} from '../../util/types';
import { ParsedModelFinder, ParsedModelFinderKnown } from '../../util/model';
import {
    CoordinateSystem, CoordinateSystemMaster,
} from '../CoordinateSystem';
import { expandOrShrinkRect } from '../../util/graphic';
import { injectCoordSysByOption, simpleCoordSysInjectionProvider } from '../../core/CoordinateSystem';
import {
    LegendAvoidableCoordinateSystem,
    LayoutLegendContext,
    fillLegendGroupSpaceToMargin,
    collectCoordLabelSeries,
    calculateOuterBoundingRectWithLabels,
    calculateRectExpansionMargin,
    isMarginAllZero,
    calculateSeriesLabelBoundingRects,
    calculateSymbolRect,
    calculateSeriesLabelOverflowMargin
} from '../../util/autoLayout';
import type CalendarView from '../../component/calendar/CalendarView';

// (24*60*60*1000)
const PROXIMATE_ONE_DAY = 86400000;


export interface CalendarParsedDateRangeInfo {
    range: [string, string],
    start: CalendarParsedDateInfo
    end: CalendarParsedDateInfo
    allDay: number
    weeks: number
    nthWeek: number
    fweek: number
    lweek: number
}

export interface CalendarParsedDateInfo {
    /**
     * local full year, eg., '1940'
     */
    y: string
    /**
     * local month, from '01' ot '12',
     */
    m: string
    /**
     * local date, from '01' to '31' (if exists),
     */
    d: string
    /**
     * It is not date.getDay(). It is the location of the cell in a week, from 0 to 6,
     */
    day: number
    /**
     * Timestamp
     */
    time: number
    /**
     * yyyy-MM-dd
     */
    formatedDate: string
    /**
     * The original date object
     */
    date: Date
}

interface CalendarCellRect {
    center: number[]
    tl: number[]
    tr: number[]
    br: number[]
    bl: number[]
}

class Calendar implements CoordinateSystem, CoordinateSystemMaster, LegendAvoidableCoordinateSystem {

    static readonly dimensions = ['time', 'value'];
    static getDimensionsInfo() {
        return [{
            name: 'time', type: 'time' as const
        }, 'value'];
    }

    readonly type = 'calendar';

    readonly dimensions = Calendar.dimensions;

    private _model: CalendarModel;

    private _rect: BoundingRect;

    private _sw: number;
    private _sh: number;
    private _orient: LayoutOrient;

    private _firstDayOfWeek: number;

    private _rangeInfo: CalendarParsedDateRangeInfo;

    private _lineWidth: number;

    private _ecModel: GlobalModel;

    /** @implements LegendAvoidableCoordinateSystem */
    autoLayoutContext: LayoutLegendContext | undefined;

    constructor(calendarModel: CalendarModel, ecModel: GlobalModel, api: ExtensionAPI) {
        this._model = calendarModel;
        this._ecModel = ecModel;
        this._update(ecModel, api);
    }
    // Required in createListFromData
    getDimensionsInfo = Calendar.getDimensionsInfo;

    getRangeInfo() {
        return this._rangeInfo;
    }

    getModel() {
        return this._model;
    }

    getRect() {
        return this._rect;
    }

    getCellWidth() {
        return this._sw;
    }

    getCellHeight() {
        return this._sh;
    }

    getOrient() {
        return this._orient;
    }

    /**
     * getFirstDayOfWeek
     *
     * @example
     *     0 : start at Sunday
     *     1 : start at Monday
     *
     * @return {number}
     */
    getFirstDayOfWeek() {
        return this._firstDayOfWeek;
    }

    /**
     * get date info
     * }
     */
    getDateInfo(date: OptionDataValueDate): CalendarParsedDateInfo {

        date = numberUtil.parseDate(date);

        const y = date.getFullYear();

        const m = date.getMonth() + 1;
        const mStr = m < 10 ? '0' + m : '' + m;

        const d = date.getDate();
        const dStr = d < 10 ? '0' + d : '' + d;

        let day = date.getDay();

        day = Math.abs((day + 7 - this.getFirstDayOfWeek()) % 7);

        return {
            y: y + '',
            m: mStr,
            d: dStr,
            day: day,
            time: date.getTime(),
            formatedDate: y + '-' + mStr + '-' + dStr,
            date: date
        };
    }

    getNextNDay(date: OptionDataValueDate, n: number) {
        n = n || 0;
        if (n === 0) {
            return this.getDateInfo(date);
        }

        date = new Date(this.getDateInfo(date).time);
        date.setDate(date.getDate() + n);

        return this.getDateInfo(date);
    }

    private _update(ecModel: GlobalModel, api: ExtensionAPI) {

        this._firstDayOfWeek = +this._model.getModel('dayLabel').get('firstDay');
        this._orient = this._model.get('orient');
        this._lineWidth = this._model.getModel('itemStyle').getItemStyle().lineWidth || 0;


        this._rangeInfo = this._getRangeInfo(this._initRangeOption());
        const weeks = this._rangeInfo.weeks || 1;
        const whNames = ['width', 'height'] as const;
        const cellSize = this._model.getCellSize().slice();
        const layoutParams = this._model.getBoxLayoutParams();
        const cellNumbers = this._orient === 'horizontal' ? [weeks, 7] : [7, weeks];

        function cellSizeSpecified(cellSize: (number | 'auto')[], idx: number): cellSize is number[] {
            return cellSize[idx] != null && cellSize[idx] !== 'auto';
        }

        zrUtil.each([0, 1] as const, function (idx) {
            if (cellSizeSpecified(cellSize, idx)) {
                layoutParams[whNames[idx]] = cellSize[idx] * cellNumbers[idx];
            }
        });

        const whGlobal = {
            width: api.getWidth(),
            height: api.getHeight()
        };
        this._rect = layout.getLayoutRect(layoutParams, whGlobal);
        this._updateCellSize();
    }

    private _updateCellSize() {
        const calendarRect = this._rect;
        const weeks = this._rangeInfo.weeks || 1;
        const whNames = ['width', 'height'] as const;
        const cellSize = this._model.getCellSize().slice();
        const cellNumbers = this._orient === 'horizontal' ? [weeks, 7] : [7, weeks];

        zrUtil.each([0, 1], function (idx) {
            if (!cellSizeSpecified(cellSize, idx)) {
                cellSize[idx] = calendarRect[whNames[idx]] / cellNumbers[idx];
            }
        });

        function cellSizeSpecified(cellSize: (number | 'auto')[], idx: number): cellSize is number[] {
            return cellSize[idx] != null && cellSize[idx] !== 'auto';
        }

        // Has been calculated out number.
        this._sw = cellSize[0] as number;
        this._sh = cellSize[1] as number;
    }

    /** @implements LegendAvoidableCoordinateSystem */
    getOuterBoundingRect(): BoundingRect | null {
        return this.getRect();
    }

    /** @implements LegendAvoidableCoordinateSystem */
    applyAutoLayout(ecModel: GlobalModel, api: ExtensionAPI): void {
        // 获取画布的整体宽高，作为后续布局的参考（全局画布尺寸）
        const whGlobal = {
            width: api.getWidth(),
            height: api.getHeight()
        };

        // 获取日历组件的布局参数
        const layoutParams = this._model.getBoxLayoutParams();

        // 根据布局参数和全局尺寸计算日历本体的矩形区域
        const calendarRect = this._rect = layout.getLayoutRect(layoutParams, whGlobal);

        // 之后会动态修正 finalBoundingRect，使其包含日历和所有溢出元素（如标签等），用于智能布局
        let finalBoundingRect: ZRRectLike;

        // -------- 自动布局处理（需先于 adaptiveLayout逻辑） --------
        // autoLayoutContext：如果启用自动布局（如图例避让等），相关上下文会被设置
        if (this.autoLayoutContext != null) {
            // 如果需要自动布局（如图例避让），须计算完整的外包围矩形（含所有标签等），
            // 以指导图例等组件进行避让布局
            if (this.autoLayoutContext.needLayout === true) {
                // 计算包含所有日历标签的外包围矩形，便于 legend 避让
                finalBoundingRect = this._calculateLabelBoundingRectForAutoLayout(api);

                // 将 legend 组的空间和自动布局间隙叠加到 margin，上下文一同传递下去
                fillLegendGroupSpaceToMargin(
                    this.autoLayoutContext.group,
                    api,
                    finalBoundingRect,
                    null,
                    this.autoLayoutContext
                );
            }

            // 配置里如果显式设置了 margin，则根据 margin 对 rect 和外包围矩形做边距调整
            if (this.autoLayoutContext.margin != null) {
                const contextMargin = this.autoLayoutContext.margin;
                // 对日历实际布局做边距扩展/收缩
                expandOrShrinkRect(calendarRect, contextMargin, true, true);
                // 如果存在 finalBoundingRect 也一并处理
                if (finalBoundingRect) {
                    expandOrShrinkRect(finalBoundingRect, contextMargin, true, true);
                }
            }
        }

        // -------- 处理日历自身的 label（如星期、月份等文字）的溢出压缩 --------
        if (this._model.get('adaptiveLayout')) {
            // labelRefContainer 设置为当前完整画布（此处保证无论怎么扩展都在全局内计算出最终 margin）
            const labelRefContainer = {
                x: 0,
                y: 0,
                width: api.getWidth(),
                height: api.getHeight()
            } as ZRRectLike;

            // 计算并应用日历自带的标签（如年、月、星期等）溢出扩展区
            const labelOverflowMargin = this._calculateLabelOverflowMargin(api, labelRefContainer);
            if (labelOverflowMargin) {
                // 对calendarRect和最终包围矩形都做边距扩展
                expandOrShrinkRect(calendarRect, labelOverflowMargin, true, true);
                if (finalBoundingRect) {
                    expandOrShrinkRect(finalBoundingRect, labelOverflowMargin, true, true);
                }
            }

            // 计算系列（series）标签的溢出边距（如日历格子上的数据标签），同理处理
            const seriesLabelOverflowMargin = this._calculateSeriesLabelOverflowMargin(labelRefContainer, api);
            if (seriesLabelOverflowMargin) {
                expandOrShrinkRect(calendarRect, seriesLabelOverflowMargin, true, true);
                if (finalBoundingRect) {
                    expandOrShrinkRect(finalBoundingRect, seriesLabelOverflowMargin, true, true);
                }
                // 边界变化后需要同步更新格子尺寸
                this._updateCellSize();
            }

            // 如果 finalBoundingRect 存在，说明需要再次用当前最新扩展后的 rect 重新计算外包围
            if (finalBoundingRect) {
                finalBoundingRect = this._calculateLabelBoundingRectForAutoLayout(api);
            }
        }

        // -------- 日历布局全部完成后，记录最终的包围盒，便于其它组件/业务引用 --------
        if (this.autoLayoutContext?.needLayout === true) {
            this.autoLayoutContext.finalBoundingRect = finalBoundingRect;
        }

        // 日历图本身由于容器矩形可能被多次扩展，所以需再次刷新内部格子尺寸
        this._updateCellSize();
    }

    /**
     * 获取包含日历本身和所有日历标签（如星期、月份、年等）的完整包围盒。
     *
     * @param api ExtensionAPI 实例，用于获取当前组件视图。
     * @returns 返回包含日历和标签的包围矩形，如无法获取则返回基础日历区域（getOuterBoundingRect）。
     */
    private _getRectWithLabels(api: ExtensionAPI): BoundingRect | null {
        // 尝试通过 CalendarView 的 getOuterBoundingRect 方法获取包含标签的外包围
        const calendarView = api.getViewOfComponentModel(this._model) as CalendarView;
        if (calendarView && calendarView.getOuterBoundingRect) {
            return calendarView.getOuterBoundingRect(this._model, this._ecModel, api);
        }

        // 若未获取到视图或方法不存在，则退回只包含日历区域的基础包围盒
        const baseRect = this.getOuterBoundingRect();
        if (!baseRect) {
            return null;
        }
        return baseRect;
    }

    /**
     * 计算仅日历标签（如星期、月份、年份等）因溢出所需扩展的 margin。
     *
     * @param api ExtensionAPI 实例。
     * @param refContainer 外部参考容器矩形（如整个画布）。
     * @returns 返回所需的扩展边距数组 [top, right, bottom, left]；如无需扩展则返回 null。
     */
    private _calculateLabelOverflowMargin(
        api: ExtensionAPI,
        refContainer: RectLike
    ): number[] | null {
        // 获取包含标签的完整日历区域
        const calendarRectWithLabels = this._getRectWithLabels(api);
        if (!calendarRectWithLabels) {
            return null;
        }

        // 计算标签的溢出边距
        const margin = calculateRectExpansionMargin(
            refContainer,
            calendarRectWithLabels
        );

        // 如果没有实际发生压缩（margin 全为零），则返回 null
        return isMarginAllZero(margin) ? null : margin;
    }

    /**
     * 计算所有系列（series）标签在日历坐标系下的溢出扩展边距。
     *
     * @param refContainer 外部参考容器矩形。
     * @returns 返回所需扩展的边距数组 [top, right, bottom, left]；如无需扩展返回 null。
     */
    private _calculateSeriesLabelOverflowMargin(
        refContainer: RectLike,
        api: ExtensionAPI
    ): number[] | null {
        const seriesList = collectCoordLabelSeries(this._ecModel, this);
        if (seriesList.length === 0) {
            return null;
        }

        const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);
        const seriesLabelOverflowMargin = calculateSeriesLabelOverflowMargin(
            seriesLabelBoundingRects,
            refContainer
        );

        return isMarginAllZero(seriesLabelOverflowMargin) ? null : seriesLabelOverflowMargin;
    }

    /**
     * 针对 calendar 坐标系，批量计算所有系列标签的包围盒。
     *
     * @param seriesList 系列（SeriesModel）集合
     * @param api ExtensionAPI 实例
     * @returns 返回系列标签包围矩形数组，每一项包含 rect 与对齐信息
     */
    private _calculateSeriesLabelBoundingRects(seriesList: SeriesModel[], api: ExtensionAPI): Array<{
        rect: BoundingRect;
        textAlign: string;
    }> {
        const calendarCoord = this;
        return calculateSeriesLabelBoundingRects(
            seriesList,
            api,
            (seriesModel, data) => {
                const items: Array<{
                    dataIndex: number;
                    point: number[];
                    symbolRect: BoundingRect;
                    labelText: string;
                }> = [];

                data.each((idx: number) => {
                    // 获取当前数据项的实际数值
                    const dataValue = data.getValues([calendarCoord.dimensions[0]], idx);
                    // 计算该数据点在日历坐标上的实际像素点位置
                    const point = calendarCoord.dataToPoint(dataValue);
                    if (dataValue == null || !point || point.length < 2) {
                        return;
                    }

                    // Create symbol bounding rect using unified function
                    const symbolRect = calculateSymbolRect(seriesModel, data, idx, point, api);
                    if (!symbolRect) {
                        return;
                    }

                    const labelText = seriesModel.getFormattedLabel(idx, 'normal');
                    if (labelText == null || labelText === '') {
                        return;
                    }

                    items.push({
                        dataIndex: idx,
                        point: point,
                        symbolRect: symbolRect,
                        labelText: labelText
                    });
                });

                return items;
            }
        );
    }

    /**
     * 计算用于自动布局避让图例（legend）的最大外部包围盒。
     *
     * @param api ExtensionAPI 实例。
     * @param refContainer 用于对齐比较的容器矩形。
     * @returns 返回一个包含日历标签以及所有系列标签的完整区域。
     */
    private _calculateLabelBoundingRectForAutoLayout(
        api: ExtensionAPI
    ): RectLike {
        const calendarRectWithLabels = this._getRectWithLabels(api);
        if (!calendarRectWithLabels) {
            return this.getRect();
        }

        const seriesList = collectCoordLabelSeries(this._ecModel, this);
        if (seriesList.length === 0) {
            return calendarRectWithLabels;
        }

        const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);
        if (seriesLabelBoundingRects.length === 0) {
            return calendarRectWithLabels;
        }

        return calculateOuterBoundingRectWithLabels(
            calendarRectWithLabels,
            seriesLabelBoundingRects
        );
    }

    /**
     * Convert a time data(time, value) item to (x, y) point.
     */
    // TODO Clamp of calendar is not same with cartesian coordinate systems.
    // It will return NaN if data exceeds.
    dataToPoint(
        data: OptionDataValueDate | OptionDataValueDate[],
        clamp?: boolean,
        out?: number[]
    ): number[] {
        out = out || [];
        zrUtil.isArray(data) && (data = data[0]);
        clamp == null && (clamp = true);

        const dayInfo = this.getDateInfo(data);
        const range = this._rangeInfo;
        const date = dayInfo.formatedDate;

        // if not in range return [NaN, NaN]
        if (clamp && !(
            dayInfo.time >= range.start.time
            && dayInfo.time < range.end.time + PROXIMATE_ONE_DAY
        )) {
            out[0] = out[1] = NaN;
            return out;
        }

        const week = dayInfo.day;
        const nthWeek = this._getRangeInfo([range.start.time, date]).nthWeek;

        if (this._orient === 'vertical') {
            out[0] = this._rect.x + week * this._sw + this._sw / 2;
            out[1] = this._rect.y + nthWeek * this._sh + this._sh / 2;
        }
        else {
            out[0] = this._rect.x + nthWeek * this._sw + this._sw / 2;
            out[1] = this._rect.y + week * this._sh + this._sh / 2;
        }
        return out;

    }

    /**
     * Convert a (x, y) point to time data
     */
    pointToData(point: number[]): number {

        const date = this.pointToDate(point);

        return date && date.time;
    }

    dataToLayout(
        data: OptionDataValueDate | OptionDataValueDate[],
        clamp?: boolean,
        out?: CoordinateSystemDataLayout
    ): CoordinateSystemDataLayout {
        out = out || {} as CoordinateSystemDataLayout;
        const rect = out.rect = out.rect || {} as RectLike;
        const contentRect = out.contentRect = out.contentRect || {} as RectLike;
        const point = this.dataToPoint(data, clamp);

        rect.x = point[0] - (this._sw) / 2;
        rect.y = point[1] - (this._sh) / 2;
        rect.width = this._sw;
        rect.height = this._sh;

        BoundingRect.copy(contentRect, rect);
        expandOrShrinkRect(contentRect, this._lineWidth / 2, true, true);

        return out;
    }

    /**
     * Convert a time date item to (x, y) four point.
     */
    dataToCalendarLayout(
        data: OptionDataValueDate | OptionDataValueDate[],
        clamp?: boolean,
    ): CalendarCellRect {
        const point = this.dataToPoint(data, clamp);
        return {
            center: point,
            tl: [
                point[0] - this._sw / 2,
                point[1] - this._sh / 2
            ],
            tr: [
                point[0] + this._sw / 2,
                point[1] - this._sh / 2
            ],
            br: [
                point[0] + this._sw / 2,
                point[1] + this._sh / 2
            ],
            bl: [
                point[0] - this._sw / 2,
                point[1] + this._sh / 2
            ],
        };
    }

    /**
     * Convert a (x, y) point to time date
     *
     * @param  {Array} point point
     * @return {Object}       date
     */
    pointToDate(point: number[]): CalendarParsedDateInfo {
        const nthX = Math.floor((point[0] - this._rect.x) / this._sw) + 1;
        const nthY = Math.floor((point[1] - this._rect.y) / this._sh) + 1;
        const range = this._rangeInfo.range;

        if (this._orient === 'vertical') {
            return this._getDateByWeeksAndDay(nthY, nthX - 1, range);
        }

        return this._getDateByWeeksAndDay(nthX, nthY - 1, range);
    }

    convertToPixel(
        ecModel: GlobalModel, finder: ParsedModelFinder, value: ScaleDataValue | ScaleDataValue[]
    ) {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? coordSys.dataToPoint(value) : null;
    }

    convertToLayout(
        ecModel: GlobalModel, finder: ParsedModelFinder, value: ScaleDataValue | ScaleDataValue[]
    ) {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? coordSys.dataToLayout(value) : null;
    }

    convertFromPixel(ecModel: GlobalModel, finder: ParsedModelFinder, pixel: number[]) {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? coordSys.pointToData(pixel) : null;
    }

    containPoint(point: number[]): boolean {
        console.warn('Not implemented.');
        return false;
    }

    /**
     * initRange
     * Normalize to an [start, end] array
     */
    private _initRangeOption(): OptionDataValueDate[] {
        let range = this._model.get('range');
        let normalizedRange: OptionDataValueDate[];

        // Convert [1990] to 1990
        if (zrUtil.isArray(range) && range.length === 1) {
            range = range[0];
        }

        if (!zrUtil.isArray(range)) {
            const rangeStr = range.toString();
            // One year.
            if (/^\d{4}$/.test(rangeStr)) {
                normalizedRange = [rangeStr + '-01-01', rangeStr + '-12-31'];
            }
            // One month
            if (/^\d{4}[\/|-]\d{1,2}$/.test(rangeStr)) {

                const start = this.getDateInfo(rangeStr);
                const firstDay = start.date;
                firstDay.setMonth(firstDay.getMonth() + 1);

                const end = this.getNextNDay(firstDay, -1);
                normalizedRange = [start.formatedDate, end.formatedDate];
            }
            // One day
            if (/^\d{4}[\/|-]\d{1,2}[\/|-]\d{1,2}$/.test(rangeStr)) {
                normalizedRange = [rangeStr, rangeStr];
            }
        }
        else {
            normalizedRange = range;
        }

        if (!normalizedRange) {
            if (__DEV__) {
                zrUtil.logError('Invalid date range.');
            }
            // Not handling it.
            return range as OptionDataValueDate[];
        }

        const tmp = this._getRangeInfo(normalizedRange);

        if (tmp.start.time > tmp.end.time) {
            normalizedRange.reverse();
        }

        return normalizedRange;
    }

    /**
     * range info
     *
     * @private
     * @param  {Array} range range ['2017-01-01', '2017-07-08']
     *  If range[0] > range[1], they will not be reversed.
     * @return {Object}       obj
     */
    _getRangeInfo(range: OptionDataValueDate[]): CalendarParsedDateRangeInfo {
        const parsedRange = [
            this.getDateInfo(range[0]),
            this.getDateInfo(range[1])
        ];

        let reversed;
        if (parsedRange[0].time > parsedRange[1].time) {
            reversed = true;
            parsedRange.reverse();
        }

        let allDay = Math.floor(parsedRange[1].time / PROXIMATE_ONE_DAY)
            - Math.floor(parsedRange[0].time / PROXIMATE_ONE_DAY) + 1;

        // Consider case1 (#11677 #10430):
        // Set the system timezone as "UK", set the range to `['2016-07-01', '2016-12-31']`

        // Consider case2:
        // Firstly set system timezone as "Time Zone: America/Toronto",
        // ```
        // let first = new Date(1478412000000 - 3600 * 1000 * 2.5);
        // let second = new Date(1478412000000);
        // let allDays = Math.floor(second / ONE_DAY) - Math.floor(first / ONE_DAY) + 1;
        // ```
        // will get wrong result because of DST. So we should fix it.
        const date = new Date(parsedRange[0].time);
        const startDateNum = date.getDate();
        const endDateNum = parsedRange[1].date.getDate();
        date.setDate(startDateNum + allDay - 1);
        // The bias can not over a month, so just compare date.
        let dateNum = date.getDate();
        if (dateNum !== endDateNum) {
            const sign = date.getTime() - parsedRange[1].time > 0 ? 1 : -1;
            while (
                (dateNum = date.getDate()) !== endDateNum
                && (date.getTime() - parsedRange[1].time) * sign > 0
            ) {
                allDay -= sign;
                date.setDate(dateNum - sign);
            }
        }

        const weeks = Math.floor((allDay + parsedRange[0].day + 6) / 7);
        const nthWeek = reversed ? -weeks + 1 : weeks - 1;

        reversed && parsedRange.reverse();

        return {
            range: [parsedRange[0].formatedDate, parsedRange[1].formatedDate],
            start: parsedRange[0],
            end: parsedRange[1],
            allDay: allDay,
            weeks: weeks,
            // From 0.
            nthWeek: nthWeek,
            fweek: parsedRange[0].day,
            lweek: parsedRange[1].day
        };
    }

    /**
     * get date by nthWeeks and week day in range
     *
     * @private
     * @param  {number} nthWeek the week
     * @param  {number} day   the week day
     * @param  {Array} range [d1, d2]
     * @return {Object}
     */
    private _getDateByWeeksAndDay(nthWeek: number, day: number, range: OptionDataValueDate[]): CalendarParsedDateInfo {
        const rangeInfo = this._getRangeInfo(range);

        if (nthWeek > rangeInfo.weeks
            || (nthWeek === 0 && day < rangeInfo.fweek)
            || (nthWeek === rangeInfo.weeks && day > rangeInfo.lweek)
        ) {
            return null;
        }

        const nthDay = (nthWeek - 1) * 7 - rangeInfo.fweek + day;
        const date = new Date(rangeInfo.start.time);
        date.setDate(+rangeInfo.start.d + nthDay);

        return this.getDateInfo(date);
    }

    static create(ecModel: GlobalModel, api: ExtensionAPI) {
        const calendarList: Calendar[] = [];

        ecModel.eachComponent('calendar', function (calendarModel: CalendarModel) {
            const calendar = new Calendar(calendarModel, ecModel, api);
            calendarList.push(calendar);
            calendarModel.coordinateSystem = calendar;
        });

        // Inject coordinate system
        ecModel.eachComponent((mainType, componentModel) => {
            injectCoordSysByOption({
                targetModel: componentModel,
                coordSysType: 'calendar',
                coordSysProvider: simpleCoordSysInjectionProvider,
            });
        });
        // 必须要在所有坐标系创建完成后才能应用自动布局。
        calendarList.forEach(calendar => {
            calendar.applyAutoLayout(ecModel, api);
        });
        return calendarList;
    }
}

function getCoordSys(finder: ParsedModelFinderKnown): Calendar {
    const calendarModel = finder.calendarModel as CalendarModel;
    const seriesModel = finder.seriesModel;

    const coordSys = calendarModel
        ? calendarModel.coordinateSystem
        : seriesModel
            ? seriesModel.coordinateSystem
            : null;

    return coordSys as Calendar;
}

export default Calendar;
