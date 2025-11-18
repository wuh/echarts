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

import { isString, extend, map, isFunction } from 'zrender/src/core/util';
import * as graphic from '../../util/graphic';
import { createTextStyle } from '../../label/labelStyle';
import { formatTplSimple } from '../../util/format';
import { parsePercent } from '../../util/number';
import type CalendarModel from '../../coord/calendar/CalendarModel';
import { CalendarParsedDateRangeInfo, CalendarParsedDateInfo } from '../../coord/calendar/Calendar';
import type GlobalModel from '../../model/Global';
import type ExtensionAPI from '../../core/ExtensionAPI';
import { LayoutOrient, OptionDataValueDate, ZRTextAlign, ZRTextVerticalAlign } from '../../util/types';
import BoundingRect from 'zrender/src/core/BoundingRect';
import ComponentView from '../../view/Component';
import { PathStyleProps } from 'zrender/src/graphic/Path';
import { TextStyleProps, TextProps } from 'zrender/src/graphic/Text';
import { LocaleOption, getLocaleModel } from '../../core/locale';
import type Model from '../../model/Model';
import { getTextRect } from '../../legacy/getTextRect';

class CalendarView extends ComponentView {

    static type = 'calendar';
    type = CalendarView.type;

    /**
     * top/left line points
     */
    private _tlpoints: number[][];

    /**
     * bottom/right line points
     */
    private _blpoints: number[][];

    /**
     * first day of month
     */
    private _firstDayOfMonth: CalendarParsedDateInfo[];

    /**
     * first day point of month
     */
    private _firstDayPoints: number[][];

    render(calendarModel: CalendarModel, ecModel: GlobalModel, api: ExtensionAPI) {

        const group = this.group;

        group.removeAll();

        const coordSys = calendarModel.coordinateSystem;

        // range info
        const rangeData = coordSys.getRangeInfo();
        const orient = coordSys.getOrient();

        // locale
        const localeModel = ecModel.getLocaleModel();

        this._renderDayRect(calendarModel, rangeData, group);

        // _renderLines must be called prior to following function
        this._renderLines(calendarModel, rangeData, orient, group);

        this._renderYearText(calendarModel, rangeData, orient, group);

        this._renderMonthText(calendarModel, localeModel, orient, group);

        this._renderWeekText(calendarModel, localeModel, rangeData, orient, group);
    }

    // render day rect
    _renderDayRect(calendarModel: CalendarModel, rangeData: CalendarParsedDateRangeInfo, group: graphic.Group) {
        const coordSys = calendarModel.coordinateSystem;
        const itemRectStyleModel = calendarModel.getModel('itemStyle').getItemStyle();
        const sw = coordSys.getCellWidth();
        const sh = coordSys.getCellHeight();

        for (let i = rangeData.start.time;
            i <= rangeData.end.time;
            i = coordSys.getNextNDay(i, 1).time
        ) {

            const point = coordSys.dataToCalendarLayout([i], false).tl;

            // every rect
            const rect = new graphic.Rect({
                shape: {
                    x: point[0],
                    y: point[1],
                    width: sw,
                    height: sh
                },
                cursor: 'default',
                style: itemRectStyleModel
            });

            group.add(rect);
        }

    }

    // render separate line
    _renderLines(
        calendarModel: CalendarModel,
        rangeData: CalendarParsedDateRangeInfo,
        orient: LayoutOrient,
        group: graphic.Group
    ) {

        const self = this;

        const coordSys = calendarModel.coordinateSystem;

        const lineStyleModel = calendarModel.getModel(['splitLine', 'lineStyle']).getLineStyle();
        const show = calendarModel.get(['splitLine', 'show']);

        const lineWidth = lineStyleModel.lineWidth;

        this._tlpoints = [];
        this._blpoints = [];
        this._firstDayOfMonth = [];
        this._firstDayPoints = [];


        let firstDay = rangeData.start;

        for (let i = 0; firstDay.time <= rangeData.end.time; i++) {
            addPoints(firstDay.formatedDate);

            if (i === 0) {
                firstDay = coordSys.getDateInfo(rangeData.start.y + '-' + rangeData.start.m);
            }

            const date = firstDay.date;
            date.setMonth(date.getMonth() + 1);
            firstDay = coordSys.getDateInfo(date);
        }

        addPoints(coordSys.getNextNDay(rangeData.end.time, 1).formatedDate);

        function addPoints(date: OptionDataValueDate) {

            self._firstDayOfMonth.push(coordSys.getDateInfo(date));
            self._firstDayPoints.push(coordSys.dataToCalendarLayout([date], false).tl);

            const points = self._getLinePointsOfOneWeek(calendarModel, date, orient);

            self._tlpoints.push(points[0]);
            self._blpoints.push(points[points.length - 1]);

            show && self._drawSplitline(points, lineStyleModel, group);
        }


        // render top/left line
        show && this._drawSplitline(self._getEdgesPoints(self._tlpoints, lineWidth, orient), lineStyleModel, group);

        // render bottom/right line
        show && this._drawSplitline(self._getEdgesPoints(self._blpoints, lineWidth, orient), lineStyleModel, group);

    }

    // get points at both ends
    _getEdgesPoints(points: number[][], lineWidth: number, orient: LayoutOrient) {
        const rs = [points[0].slice(), points[points.length - 1].slice()];
        const idx = orient === 'horizontal' ? 0 : 1;

        // both ends of the line are extend half lineWidth
        rs[0][idx] = rs[0][idx] - lineWidth / 2;
        rs[1][idx] = rs[1][idx] + lineWidth / 2;

        return rs;
    }

    // render split line
    _drawSplitline(points: number[][], lineStyle: PathStyleProps, group: graphic.Group) {

        const poyline = new graphic.Polyline({
            z2: 20,
            shape: {
                points: points
            },
            style: lineStyle
        });

        group.add(poyline);
    }

    // render month line of one week points
    _getLinePointsOfOneWeek(calendarModel: CalendarModel, date: OptionDataValueDate, orient: LayoutOrient) {

        const coordSys = calendarModel.coordinateSystem;
        const parsedDate = coordSys.getDateInfo(date);

        const points = [];

        for (let i = 0; i < 7; i++) {

            const tmpD = coordSys.getNextNDay(parsedDate.time, i);
            const point = coordSys.dataToCalendarLayout([tmpD.time], false);

            points[2 * tmpD.day] = point.tl;
            points[2 * tmpD.day + 1] = point[orient === 'horizontal' ? 'bl' : 'tr'];
        }

        return points;

    }

    _formatterLabel<T extends { nameMap: string }>(
        formatter: string | ((params: T) => string),
        params: T
    ) {

        if (isString(formatter) && formatter) {
            return formatTplSimple(formatter, params);
        }

        if (isFunction(formatter)) {
            return formatter(params);
        }

        return params.nameMap;

    }

    /**
     * 获取用于日历上显示的星期名称映射数组。
     *
     * 来源优先级为：dayLabelModel的`nameMap`配置 > locale对应的短星期文本（如
     * 'Sun'）> locale的星期简写（如'S'）。注意：如果`nameMap`为字符串，则其表示
     * 一个语言环境名，在该环境中查找；否则直接使用本地locale。若所有配置缺失，
     * 则默认按简化首字母生成（如英文'日'用'S'）。
     */
    _getDayLabelNameMap(
        dayLabelModel: Model,
        localeModel: Model<LocaleOption>
    ): string[] {
        let nameMap = dayLabelModel.get('nameMap');
        // 判断nameMap是否未配置或为字符串（需作为locale key进一步查找）
        if (!nameMap || isString(nameMap)) {
            if (nameMap) {
                // 若配置为字符串（如'en'、'zh'），则取对应的 locale 配置
                const tmpLocaleModel = getLocaleModel(nameMap as string) || localeModel;
                // 优先用短星期名（如 Mon~Sun），否则取简写首字母
                const dayOfWeekShort = tmpLocaleModel.get(['time', 'dayOfWeekShort' as any]);
                nameMap = dayOfWeekShort || map(
                    tmpLocaleModel.get(['time', 'dayOfWeekAbbr']),
                    val => val[0]
                );
            }
            else {
                // 若未传nameMap，直接用默认locale，取短星期名或简写首字母
                const dayOfWeekShort = localeModel.get(['time', 'dayOfWeekShort' as any]);
                nameMap = dayOfWeekShort || map(
                    localeModel.get(['time', 'dayOfWeekAbbr']),
                    val => val[0]
                );
            }
        }
        return nameMap;
    }

    /**
     * 获取用于日历上显示的月份名称映射数组。
     *
     * 来源优先级为：monthLabelModel的`nameMap`配置 > locale对应的月份缩写（如
     * 'Jan'~'Dec'）。注意：如`nameMap`为字符串，则视为语言环境名，优先采用该语
     * 言环境；否则直接使用本地locale配置。若所有配置均缺失，则返回空数组，防止
     * UI报错。
     */
    _getMonthLabelNameMap(
        monthLabelModel: Model,
        localeModel: Model<LocaleOption>
    ): string[] {
        let nameMap = monthLabelModel.get('nameMap');
        if (!nameMap || isString(nameMap)) {
            if (nameMap) {
                // 指定了语言环境（如'en'、'zh'），优先采用该locale下的月份简称
                const tmpLocaleModel = getLocaleModel(nameMap as string) || localeModel;
                nameMap = tmpLocaleModel.get(['time', 'monthAbbr']) || [];
            }
            else {
                // 否则默认用初始化时的locale配置
                nameMap = localeModel.get(['time', 'monthAbbr']) || [];
            }
        }
        return nameMap;
    }

    /**
     * 获取年份标签文本（会考虑跨年情况，如“2020-2021”）。
     *
     * 若年份有定制化formatter，支持模版字符串或回调函数，则会执行格式化，否则返
     * 回默认的年区间名。 params内提供start年、end年、nameMap（显示用年区间字符
     * 串）。
     */
    _getYearLabelText(
        yearLabelModel: Model,
        rangeData: CalendarParsedDateRangeInfo
    ): string {
        // 默认使用起始年作为标签名
        let name = rangeData.start.y;

        // 判断是否跨年，若跨年则用“起止年-终止年”
        if (+rangeData.end.y > +rangeData.start.y) {
            name = name + '-' + rangeData.end.y;
        }

        // 可选的formatter用于自定义年标签格式（如'{start}~{end}'）
        const formatter = yearLabelModel.get('formatter');

        // 提供参数给formatter，包括开始年、结束年和默认显示名
        const params = {
            start: rangeData.start.y,
            end: rangeData.end.y,
            nameMap: name
        };

        return this._formatterLabel(formatter, params);
    }

    _yearTextPositionControl(
        textEl: graphic.Text,
        point: number[],
        orient: LayoutOrient,
        position: 'left' | 'right' | 'top' | 'bottom',
        margin: number
    ): TextProps {

        let x = point[0];
        let y = point[1];
        let aligns: [ZRTextAlign, ZRTextVerticalAlign] = ['center', 'bottom'];

        if (position === 'bottom') {
            y += margin;
            aligns = ['center', 'top'];
        }
        else if (position === 'left') {
            x -= margin;
        }
        else if (position === 'right') {
            x += margin;
            aligns = ['center', 'top'];
        }
        else { // top
            y -= margin;
        }

        let rotate = 0;
        if (position === 'left' || position === 'right') {
            rotate = Math.PI / 2;
        }

        return {
            rotation: rotate,
            x,
            y,
            style: {
                align: aligns[0],
                verticalAlign: aligns[1]
            }
        };
    }

    // render year
    _renderYearText(
        calendarModel: CalendarModel,
        rangeData: CalendarParsedDateRangeInfo,
        orient: LayoutOrient,
        group: graphic.Group
    ) {
        const yearLabel = calendarModel.getModel('yearLabel');

        if (!yearLabel.get('show')) {
            return;
        }

        const margin = yearLabel.get('margin');
        let pos = yearLabel.get('position');

        if (!pos) {
            pos = orient !== 'horizontal' ? 'top' : 'left';
        }

        const points = [this._tlpoints[this._tlpoints.length - 1], this._blpoints[0]];
        const xc = (points[0][0] + points[1][0]) / 2;
        const yc = (points[0][1] + points[1][1]) / 2;

        const idx = orient === 'horizontal' ? 0 : 1;

        const posPoints = {
            top: [xc, points[idx][1]],
            bottom: [xc, points[1 - idx][1]],
            left: [points[1 - idx][0], yc],
            right: [points[idx][0], yc]
        };

        const content = this._getYearLabelText(yearLabel, rangeData);

        const yearText = new graphic.Text({
            z2: 30,
            style: createTextStyle(yearLabel, {
                text: content
            }),
            silent: yearLabel.get('silent')
        });
        yearText.attr(this._yearTextPositionControl(yearText, posPoints[pos], orient, pos, margin));

        group.add(yearText);
    }

    _monthTextPositionControl(
        point: number[],
        isCenter: boolean,
        orient: LayoutOrient,
        position: 'start' | 'end',
        margin: number
    ): TextStyleProps {
        let align: ZRTextAlign = 'left';
        let vAlign: ZRTextVerticalAlign = 'top';
        let x = point[0];
        let y = point[1];

        if (orient === 'horizontal') {
            y = y + margin;

            if (isCenter) {
                align = 'center';
            }

            if (position === 'start') {
                vAlign = 'bottom';
            }
        }
        else {
            x = x + margin;

            if (isCenter) {
                vAlign = 'middle';
            }

            if (position === 'start') {
                align = 'right';
            }
        }

        return {
            x: x,
            y: y,
            align: align,
            verticalAlign: vAlign
        };
    }

    // render month and year text
    _renderMonthText(
        calendarModel: CalendarModel,
        localeModel: Model<LocaleOption>,
        orient: LayoutOrient,
        group: graphic.Group
    ) {
        const monthLabel = calendarModel.getModel('monthLabel');

        if (!monthLabel.get('show')) {
            return;
        }

        const nameMap = this._getMonthLabelNameMap(monthLabel, localeModel);
        let margin = monthLabel.get('margin');
        const pos = monthLabel.get('position');
        const align = monthLabel.get('align');

        const termPoints = [this._tlpoints, this._blpoints];

        const idx = pos === 'start' ? 0 : 1;
        const axis = orient === 'horizontal' ? 0 : 1;
        margin = pos === 'start' ? -margin : margin;
        const isCenter = (align === 'center');

        const labelSilent = monthLabel.get('silent');

        for (let i = 0; i < termPoints[idx].length - 1; i++) {

            const tmp = termPoints[idx][i].slice();
            const firstDay = this._firstDayOfMonth[i];

            if (isCenter) {
                const firstDayPoints = this._firstDayPoints[i];
                tmp[axis] = (firstDayPoints[axis] + termPoints[0][i + 1][axis]) / 2;
            }

            const formatter = monthLabel.get('formatter');
            const name = nameMap[+firstDay.m - 1];
            const params = {
                yyyy: firstDay.y,
                yy: (firstDay.y + '').slice(2),
                MM: firstDay.m,
                M: +firstDay.m,
                nameMap: name
            };

            const content = this._formatterLabel(formatter, params);

            const monthText = new graphic.Text({
                z2: 30,
                style: extend(
                    createTextStyle(monthLabel, { text: content }),
                    this._monthTextPositionControl(tmp, isCenter, orient, pos, margin)
                ),
                silent: labelSilent
            });

            group.add(monthText);
        }
    }

    _weekTextPositionControl(
        point: number[],
        orient: LayoutOrient,
        position: 'start' | 'end',
        margin: number,
        cellSize: number[]
    ): TextStyleProps {
        let align: ZRTextAlign = 'center';
        let vAlign: ZRTextVerticalAlign = 'middle';
        let x = point[0];
        let y = point[1];
        const isStart = position === 'start';

        if (orient === 'horizontal') {
            x = x + margin + (isStart ? 1 : -1) * cellSize[0] / 2;
            align = isStart ? 'right' : 'left';
        }
        else {
            y = y + margin + (isStart ? 1 : -1) * cellSize[1] / 2;
            vAlign = isStart ? 'bottom' : 'top';
        }

        return {
            x: x,
            y: y,
            align: align,
            verticalAlign: vAlign
        };
    }

    // render weeks
    _renderWeekText(
        calendarModel: CalendarModel,
        localeModel: Model<LocaleOption>,
        rangeData: CalendarParsedDateRangeInfo,
        orient: LayoutOrient,
        group: graphic.Group
    ) {
        const dayLabel = calendarModel.getModel('dayLabel');

        if (!dayLabel.get('show')) {
            return;
        }

        const coordSys = calendarModel.coordinateSystem;
        const pos = dayLabel.get('position');
        const nameMap = this._getDayLabelNameMap(dayLabel, localeModel);
        let margin = dayLabel.get('margin');
        const firstDayOfWeek = coordSys.getFirstDayOfWeek();

        let start = coordSys.getNextNDay(
            rangeData.end.time, (7 - rangeData.lweek)
        ).time;

        const cellSize = [coordSys.getCellWidth(), coordSys.getCellHeight()];
        margin = parsePercent(margin, Math.min(cellSize[1], cellSize[0]));

        if (pos === 'start') {
            start = coordSys.getNextNDay(
                rangeData.start.time, -(7 + rangeData.fweek)
            ).time;
            margin = -margin;
        }

        const labelSilent = dayLabel.get('silent');

        for (let i = 0; i < 7; i++) {

            const tmpD = coordSys.getNextNDay(start, i);
            const point = coordSys.dataToCalendarLayout([tmpD.time], false).center;
            let day = i;
            day = Math.abs((i + firstDayOfWeek) % 7);
            const weekText = new graphic.Text({
                z2: 30,
                style: extend(
                    createTextStyle(dayLabel, { text: nameMap[day] }),
                    this._weekTextPositionControl(point, orient, pos, margin, cellSize)
                ),
                silent: labelSilent
            });

            group.add(weekText);
        }
    }

    /**
     * 获取日历坐标系的外边界矩形。
     *
     * 是完全参考日历坐标系的渲染流程实现的估算逻辑{@see {@link render}}。
     *
     * @param calendarModel 日历模型
     * @param ecModel 全局模型
     * @param api 扩展API
     * @returns 日历坐标系的外边界矩形
     */
    getOuterBoundingRect(calendarModel: CalendarModel, ecModel: GlobalModel, api: ExtensionAPI): BoundingRect {
        const coordSys = calendarModel.coordinateSystem;
        const rangeData = coordSys.getRangeInfo();
        const orient = coordSys.getOrient();
        const rect = coordSys.getRect();
        const localeModel = ecModel.getLocaleModel();

        // 以日历本身的渲染边界为初始外包围范围
        let minX = rect.x;
        let minY = rect.y;
        let maxX = rect.x + rect.width;
        let maxY = rect.y + rect.height;

        // ======= 推算 week/day label 的包围范围 =======
        // 如果显示星期标签（周几），需将标签高度或宽度纳入外包围计算
        const dayLabelModel = calendarModel.getModel('dayLabel');
        if (dayLabelModel.get('show')) {
            const pos = dayLabelModel.get('position');
            let margin = dayLabelModel.get('margin');
            // cellSize 取单元格的最小边，用于百分比边距解析，保证边距相对合理
            const cellSize = [coordSys.getCellWidth(), coordSys.getCellHeight()];
            margin = parsePercent(margin, Math.min(cellSize[1], cellSize[0]));

            const nameMap = this._getDayLabelNameMap(dayLabelModel, localeModel);

            // 计算所有星期标签中的最大宽高，使包围盒能适配所有文字
            let maxDayLabelWidth = 0;
            let maxDayLabelHeight = 0;
            for (let i = 0; i < 7; i++) {
                const dayText = nameMap[i] || '';
                const textRect = getTextRect(
                    dayText,
                    dayLabelModel.getFont(),
                    'center',
                    'middle'
                );
                maxDayLabelWidth = Math.max(maxDayLabelWidth, textRect.width);
                maxDayLabelHeight = Math.max(maxDayLabelHeight, textRect.height);
            }

            // 按方向和设置的 pos，调整包围盒，以容纳 dayLabel
            if (orient === 'horizontal') {
                if (pos === 'start') {
                    // 标签在顶部，向上扩展 minY
                    minY = Math.min(minY, rect.y - maxDayLabelHeight - margin);
                }
                else {
                    // 标签在底部，向下扩展 maxY
                    maxY = Math.max(maxY, rect.y + rect.height + maxDayLabelHeight + margin);
                }
            }
            else {
                if (pos === 'start') {
                    // 标签在左侧，左移 minX
                    minX = Math.min(minX, rect.x - maxDayLabelWidth - margin);
                }
                else {
                    // 标签在右侧，右扩 maxX
                    maxX = Math.max(maxX, rect.x + rect.width + maxDayLabelWidth + margin);
                }
            }
        }

        // ======= 推算 month label 的包围范围 =======
        // 月份标签（如“1月”），同上，需考虑最大标签尺寸和边距
        const monthLabelModel = calendarModel.getModel('monthLabel');
        if (monthLabelModel.get('show')) {
            const pos = monthLabelModel.get('position');
            let margin = monthLabelModel.get('margin');
            const align = monthLabelModel.get('align');

            const nameMap = this._getMonthLabelNameMap(monthLabelModel, localeModel);

            // monthLabel 若位置在起始端，margin 取负
            margin = pos === 'start' ? -margin : margin;

            // 计算所有月份中文本的最大宽度和高度
            let maxMonthLabelWidth = 0;
            let maxMonthLabelHeight = 0;
            for (let i = 0; i < nameMap.length; i++) {
                const monthText = nameMap[i] || '';
                const textRect = getTextRect(
                    monthText,
                    monthLabelModel.getFont(),
                    align === 'center' ? 'center' : (pos === 'start' ? 'right' : 'left'),
                    orient === 'horizontal' ? (pos === 'start' ? 'bottom' : 'top') : 'middle'
                );
                maxMonthLabelWidth = Math.max(maxMonthLabelWidth, textRect.width);
                maxMonthLabelHeight = Math.max(maxMonthLabelHeight, textRect.height);
            }

            // 不同方向和位置组合，修正包围盒
            if (orient === 'horizontal') {
                if (pos === 'start') {
                    // 月份标签在上沿，向上扩 minY
                    minY = Math.min(minY, rect.y - maxMonthLabelHeight - margin);
                }
                else {
                    // 月份标签在下沿，向下扩 maxY
                    maxY = Math.max(maxY, rect.y + rect.height + maxMonthLabelHeight + margin);
                }
            }
            else {
                if (pos === 'start') {
                    // 左侧扩展
                    minX = Math.min(minX, rect.x - maxMonthLabelWidth - margin);
                }
                else {
                    // 右侧扩展
                    maxX = Math.max(maxX, rect.x + rect.width + maxMonthLabelWidth + margin);
                }
            }
        }

        // ======= 推算 year label 的包围范围 =======
        // 年份标签通常显示在外边，只需考虑单个文本
        const yearLabelModel = calendarModel.getModel('yearLabel');
        if (yearLabelModel.get('show')) {
            const margin = yearLabelModel.get('margin');
            let pos = yearLabelModel.get('position');
            // 若位置未指定，水平方向默认 top，竖直默认 left，保证有参照方向
            if (!pos) {
                pos = orient !== 'horizontal' ? 'top' : 'left';
            }

            const yearText = this._getYearLabelText(yearLabelModel, rangeData);
            const textRect = getTextRect(
                yearText,
                yearLabelModel.getFont(),
                'center',
                'middle'
            );

            // 按年份标签的位置，扩展四周包围盒
            if (pos === 'top') {
                minY = Math.min(minY, rect.y - textRect.height - margin);
            }
            else if (pos === 'bottom') {
                maxY = Math.max(maxY, rect.y + rect.height + textRect.height + margin);
            }
            else if (pos === 'left') {
                minX = Math.min(minX, rect.x - textRect.width - margin);
            }
            else if (pos === 'right') {
                maxX = Math.max(maxX, rect.x + rect.width + textRect.width + margin);
            }
        }

        // 返回外包围矩形，包含日历及各类标签，保证视觉元素不被裁剪
        return new BoundingRect(
            minX,
            minY,
            maxX - minX,
            maxY - minY
        );
    }
}

export default CalendarView;
