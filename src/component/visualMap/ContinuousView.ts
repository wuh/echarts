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
import LinearGradient, { LinearGradientObject } from 'zrender/src/graphic/LinearGradient';
import * as eventTool from 'zrender/src/core/event';
import VisualMapView from './VisualMapView';
import * as graphic from '../../util/graphic';
import * as numberUtil from '../../util/number';
import sliderMove from '../helper/sliderMove';
import * as helper from './helper';
import * as modelUtil from '../../util/model';
import VisualMapModel from './VisualMapModel';
import ContinuousModel from './ContinuousModel';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import Element, { ElementEvent } from 'zrender/src/Element';
import { TextVerticalAlign, TextAlign } from 'zrender/src/core/types';
import { ColorString, Payload, ZRRectLike } from '../../util/types';
import { parsePercent } from 'zrender/src/contain/text';
import { setAsHighDownDispatcher } from '../../util/states';
import { createSymbol } from '../../util/symbol';
import ZRImage from 'zrender/src/graphic/Image';
import { ECData, getECData } from '../../util/innerStore';
import { applyPaddingToRect } from '../../util/autoLayout';
import { createTextStyle } from '../../label/labelStyle';
import { findEventDispatcher } from '../../util/event';

const linearMap = numberUtil.linearMap;
const each = zrUtil.each;
const mathMin = Math.min;
const mathMax = Math.max;

// Arbitrary value
const HOVER_LINK_SIZE = 12;
const HOVER_LINK_OUT = 6;

type Orient = VisualMapModel['option']['orient'];

type ShapeStorage = {
    handleThumbs: graphic.Path[]
    handleLabelPoints: number[][]
    handleLabels: graphic.Text[]

    inRange: graphic.Polygon
    outOfRange: graphic.Polygon

    mainGroup: graphic.Group

    indicator: graphic.Path
    indicatorLabel: graphic.Text
    indicatorLabelPoint: number[]
};

type TargetDataIndices = ReturnType<ContinuousModel['findTargetDataIndices']>;

type BarVisual = {
    barColor: LinearGradient,
    barPoints: number[][]
    handlesColor: ColorString[]
};

type Direction = 'left' | 'right' | 'top' | 'bottom';
// Notice:
// Any "interval" should be by the order of [low, high].
// "handle0" (handleIndex === 0) maps to
// low data value: this._dataInterval[0] and has low coord.
// "handle1" (handleIndex === 1) maps to
// high data value: this._dataInterval[1] and has high coord.
// The logic of transform is implemented in this._createBarGroup.

class ContinuousView extends VisualMapView {
    static type = 'visualMap.continuous';
    type = ContinuousView.type;

    visualMapModel: ContinuousModel;

    private _shapes = {} as ShapeStorage;

    private _dataInterval: number[] = [];

    private _handleEnds: number[] = [];

    private _orient: Orient;

    private _useHandle: boolean;

    private _hoverLinkDataIndices: TargetDataIndices = [];

    private _dragging: boolean;

    private _hovering: boolean;

    private _firstShowIndicator: boolean;

    init(ecModel: GlobalModel, api: ExtensionAPI) {
        super.init(ecModel, api);

        this._hoverLinkFromSeriesMouseOver = zrUtil.bind(this._hoverLinkFromSeriesMouseOver, this);
        this._hideIndicator = zrUtil.bind(this._hideIndicator, this);
    }

    doRender(
        visualMapModel: ContinuousModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: {type: string, from: string}
    ) {
        if (!payload || payload.type !== 'selectDataRange' || payload.from !== this.uid) {
            this._buildView();
        }
    }

    private _buildView() {
        this.group.removeAll();

        const visualMapModel = this.visualMapModel;
        const thisGroup = this.group;

        this._orient = visualMapModel.get('orient');
        this._useHandle = visualMapModel.get('calculable');

        this._resetInterval();

        this._renderBar(thisGroup);

        const dataRangeText = visualMapModel.get('text');
        this._renderEndsText(thisGroup, dataRangeText, 0);
        this._renderEndsText(thisGroup, dataRangeText, 1);

        // Do this for background size calculation.
        this._updateView(true);

        // After updating view, inner shapes is built completely,
        // and then background can be rendered.
        this.renderBackground(thisGroup);

        // Real update view
        this._updateView();

        this._enableHoverLinkToSeries();
        this._enableHoverLinkFromSeries();

        this.positionGroup(thisGroup);
    }

    private _renderEndsText(group: graphic.Group, dataRangeText: string[], endsIndex?: 0 | 1) {
        if (!dataRangeText) {
            return;
        }

        // Compatible with ec2, text[0] map to high value, text[1] map low value.
        let text = dataRangeText[1 - endsIndex];
        text = text != null ? text + '' : '';

        const visualMapModel = this.visualMapModel;
        const textGap = visualMapModel.get('textGap');
        const itemSize = visualMapModel.itemSize;

        const barGroup = this._shapes.mainGroup;
        const position = this._applyTransform(
            [
                itemSize[0] / 2,
                endsIndex === 0 ? -textGap : itemSize[1] + textGap
            ],
            barGroup
        ) as number[];
        const align = this._applyTransform(
            endsIndex === 0 ? 'bottom' : 'top',
            barGroup
        );
        const orient = this._orient;
        const textStyleModel = this.visualMapModel.textStyleModel;

        this.group.add(new graphic.Text({
            style: createTextStyle(textStyleModel, {
                x: position[0],
                y: position[1],
                verticalAlign: textStyleModel.get('verticalAlign')
                    || (orient === 'horizontal' ? 'middle' : align as TextVerticalAlign),
                align: textStyleModel.get('align')
                    || (orient === 'horizontal' ? align as TextAlign : 'center'),
                text
            })
        }));
    }

    private _renderBar(targetGroup: graphic.Group) {
        const visualMapModel = this.visualMapModel;
        const shapes = this._shapes;
        const itemSize = visualMapModel.itemSize;
        const orient = this._orient;
        const useHandle = this._useHandle;
        const itemAlign = helper.getItemAlign(visualMapModel, this.api, itemSize);
        const mainGroup = shapes.mainGroup = this._createBarGroup(itemAlign);

        const gradientBarGroup = new graphic.Group();
        mainGroup.add(gradientBarGroup);

        // Bar
        gradientBarGroup.add(shapes.outOfRange = createPolygon());
        gradientBarGroup.add(shapes.inRange = createPolygon(
            null,
            useHandle ? getCursor(this._orient) : null,
            zrUtil.bind(this._dragHandle, this, 'all', false),
            zrUtil.bind(this._dragHandle, this, 'all', true)
        ));

        // A border radius clip.
        gradientBarGroup.setClipPath(new graphic.Rect({
            shape: {
                x: 0,
                y: 0,
                width: itemSize[0],
                height: itemSize[1],
                r: 3
            }
        }));

        const textRect = visualMapModel.textStyleModel.getTextRect('国');
        const textSize = mathMax(textRect.width, textRect.height);

        // Handle
        if (useHandle) {
            shapes.handleThumbs = [];
            shapes.handleLabels = [];
            shapes.handleLabelPoints = [];

            this._createHandle(visualMapModel, mainGroup, 0, itemSize, textSize, orient);
            this._createHandle(visualMapModel, mainGroup, 1, itemSize, textSize, orient);
        }

        this._createIndicator(visualMapModel, mainGroup, itemSize, textSize, orient);

        targetGroup.add(mainGroup);
    }

    private _createHandle(
        visualMapModel: ContinuousModel,
        mainGroup: graphic.Group,
        handleIndex: 0 | 1,
        itemSize: number[],
        textSize: number,
        orient: Orient
    ) {
        const onDrift = zrUtil.bind(this._dragHandle, this, handleIndex, false);
        const onDragEnd = zrUtil.bind(this._dragHandle, this, handleIndex, true);
        const handleSize = parsePercent(visualMapModel.get('handleSize'), itemSize[0]);
        const handleThumb = createSymbol(
            visualMapModel.get('handleIcon'),
            -handleSize / 2, -handleSize / 2, handleSize, handleSize,
            null, true
        );
        const cursor = getCursor(this._orient);
        handleThumb.attr({
            cursor: cursor,
            draggable: true,
            drift: onDrift,
            ondragend: onDragEnd,
            onmousemove(e) {
                eventTool.stop(e.event);
            }
        });
        handleThumb.x = itemSize[0] / 2;

        handleThumb.useStyle(visualMapModel.getModel('handleStyle').getItemStyle());
        (handleThumb as graphic.Path).setStyle({
            strokeNoScale: true,
            strokeFirst: true
        });
        (handleThumb as graphic.Path).style.lineWidth *= 2;

        handleThumb.ensureState('emphasis').style = visualMapModel.getModel(['emphasis', 'handleStyle']).getItemStyle();
        setAsHighDownDispatcher(handleThumb, true);

        mainGroup.add(handleThumb);

        // Text is always horizontal layout but should not be effected by
        // transform (orient/inverse). So label is built separately but not
        // use zrender/graphic/helper/RectText, and is located based on view
        // group (according to handleLabelPoint) but not barGroup.
        const textStyleModel = this.visualMapModel.textStyleModel;
        const handleLabel = new graphic.Text({
            cursor: cursor,
            draggable: true,
            drift: onDrift,
            onmousemove(e) {
                // For mobile device, prevent screen slider on the button.
                eventTool.stop(e.event);
            },
            ondragend: onDragEnd,
            style: createTextStyle(textStyleModel, {
                x: 0,
                y: 0,
                text: ''
            })
        });
        handleLabel.ensureState('blur').style = {
            opacity: 0.1
        };
        handleLabel.stateTransition = { duration: 200 };

        this.group.add(handleLabel);

        const handleLabelPoint = [handleSize, 0];

        const shapes = this._shapes;
        shapes.handleThumbs[handleIndex] = handleThumb;
        shapes.handleLabelPoints[handleIndex] = handleLabelPoint;
        shapes.handleLabels[handleIndex] = handleLabel;
    }

    private _createIndicator(
        visualMapModel: ContinuousModel,
        mainGroup: graphic.Group,
        itemSize: number[],
        textSize: number,
        orient: Orient
    ) {
        const scale = parsePercent(visualMapModel.get('indicatorSize'), itemSize[0]);
        const indicator = createSymbol(
            visualMapModel.get('indicatorIcon'),
            -scale / 2, -scale / 2, scale, scale,
            null, true
        );
        indicator.attr({
            cursor: 'move',
            invisible: true,
            silent: true,
            x: itemSize[0] / 2
        });
        const indicatorStyle = visualMapModel.getModel('indicatorStyle').getItemStyle();
        if (indicator instanceof ZRImage) {
            const pathStyle = indicator.style;
            indicator.useStyle(zrUtil.extend({
                // TODO other properties like x, y ?
                image: pathStyle.image,
                x: pathStyle.x, y: pathStyle.y,
                width: pathStyle.width, height: pathStyle.height
            }, indicatorStyle));
        }
        else {
            indicator.useStyle(indicatorStyle);
        }

        mainGroup.add(indicator);

        const textStyleModel = this.visualMapModel.textStyleModel;
        const indicatorLabel = new graphic.Text({
            silent: true,
            invisible: true,
            style: createTextStyle(textStyleModel, {
                x: 0,
                y: 0,
                text: ''
            })
        });
        this.group.add(indicatorLabel);

        const indicatorLabelPoint = [
            (orient === 'horizontal' ? textSize / 2 : HOVER_LINK_OUT) + itemSize[0] / 2,
            0
        ];

        const shapes = this._shapes;
        shapes.indicator = indicator;
        shapes.indicatorLabel = indicatorLabel;
        shapes.indicatorLabelPoint = indicatorLabelPoint;

        this._firstShowIndicator = true;
    }

    private _dragHandle(
        handleIndex: 0 | 1 | 'all',
        isEnd?: boolean,
        // dx is event from ondragend if isEnd is true. It's not used
        dx?: number | ElementEvent,
        dy?: number
    ) {
        if (!this._useHandle) {
            return;
        }

        this._dragging = !isEnd;

        if (!isEnd) {
            // Transform dx, dy to bar coordination.
            const vertex = this._applyTransform([dx as number, dy], this._shapes.mainGroup, true) as number[];
            this._updateInterval(handleIndex, vertex[1]);

            this._hideIndicator();
            // Considering realtime, update view should be executed
            // before dispatch action.
            this._updateView();
        }

        // dragEnd do not dispatch action when realtime.
        if (isEnd === !this.visualMapModel.get('realtime')) { // jshint ignore:line
            this.api.dispatchAction({
                type: 'selectDataRange',
                from: this.uid,
                visualMapId: this.visualMapModel.id,
                selected: this._dataInterval.slice()
            });
        }

        if (isEnd) {
            !this._hovering && this._clearHoverLinkToSeries();
        }
        else if (useHoverLinkOnHandle(this.visualMapModel)) {
            this._doHoverLinkToSeries(this._handleEnds[handleIndex as 0 | 1], false);
        }
    }

    private _resetInterval() {
        const visualMapModel = this.visualMapModel;

        const dataInterval = this._dataInterval = visualMapModel.getSelected();
        const dataExtent = visualMapModel.getExtent();
        const sizeExtent = [0, visualMapModel.itemSize[1]];

        this._handleEnds = [
            linearMap(dataInterval[0], dataExtent, sizeExtent, true),
            linearMap(dataInterval[1], dataExtent, sizeExtent, true)
        ];
    }

    /**
     * @private
     * @param {(number|string)} handleIndex 0 or 1 or 'all'
     * @param {number} dx
     * @param {number} dy
     */
    private _updateInterval(handleIndex: 0 | 1 | 'all', delta: number) {
        delta = delta || 0;
        const visualMapModel = this.visualMapModel;
        const handleEnds = this._handleEnds;
        const sizeExtent = [0, visualMapModel.itemSize[1]];

        sliderMove(
            delta,
            handleEnds,
            sizeExtent,
            handleIndex,
            // cross is forbidden
            0
        );

        const dataExtent = visualMapModel.getExtent();
        // Update data interval.
        this._dataInterval = [
            linearMap(handleEnds[0], sizeExtent, dataExtent, true),
            linearMap(handleEnds[1], sizeExtent, dataExtent, true)
        ];
    }

    private _updateView(forSketch?: boolean) {
        const visualMapModel = this.visualMapModel;
        const dataExtent = visualMapModel.getExtent();
        const shapes = this._shapes;

        const outOfRangeHandleEnds = [0, visualMapModel.itemSize[1]];
        const inRangeHandleEnds = forSketch ? outOfRangeHandleEnds : this._handleEnds;

        const visualInRange = this._createBarVisual(
            this._dataInterval, dataExtent, inRangeHandleEnds, 'inRange'
        );
        const visualOutOfRange = this._createBarVisual(
            dataExtent, dataExtent, outOfRangeHandleEnds, 'outOfRange'
        );

        shapes.inRange
            .setStyle({
                fill: visualInRange.barColor
                // opacity: visualInRange.opacity
            })
            .setShape('points', visualInRange.barPoints);
        shapes.outOfRange
            .setStyle({
                fill: visualOutOfRange.barColor
                // opacity: visualOutOfRange.opacity
            })
            .setShape('points', visualOutOfRange.barPoints);

        this._updateHandle(inRangeHandleEnds, visualInRange);
    }

    private _createBarVisual(
        dataInterval: number[],
        dataExtent: number[],
        handleEnds: number[],
        forceState: ContinuousModel['stateList'][number]
    ): BarVisual {
        const opts = {
            forceState: forceState,
            convertOpacityToAlpha: true
        };
        const colorStops = this._makeColorGradient(dataInterval, opts);

        const symbolSizes = [
            this.getControllerVisual(dataInterval[0], 'symbolSize', opts) as number,
            this.getControllerVisual(dataInterval[1], 'symbolSize', opts) as number
        ];
        const barPoints = this._createBarPoints(handleEnds, symbolSizes);

        return {
            barColor: new LinearGradient(0, 0, 0, 1, colorStops),
            barPoints: barPoints,
            handlesColor: [
                colorStops[0].color,
                colorStops[colorStops.length - 1].color
            ]
        };
    }

    private _makeColorGradient(
        dataInterval: number[],
        opts: {
            forceState?: ContinuousModel['stateList'][number]
            convertOpacityToAlpha?: boolean
        }
    ) {
        // Considering colorHue, which is not linear, so we have to sample
        // to calculate gradient color stops, but not only calculate head
        // and tail.
        const sampleNumber = 100; // Arbitrary value.
        const colorStops: LinearGradientObject['colorStops'] = [];
        const step = (dataInterval[1] - dataInterval[0]) / sampleNumber;

        colorStops.push({
            color: this.getControllerVisual(dataInterval[0], 'color', opts) as ColorString,
            offset: 0
        });

        for (let i = 1; i < sampleNumber; i++) {
            const currValue = dataInterval[0] + step * i;
            if (currValue > dataInterval[1]) {
                break;
            }
            colorStops.push({
                color: this.getControllerVisual(currValue, 'color', opts) as ColorString,
                offset: i / sampleNumber
            });
        }

        colorStops.push({
            color: this.getControllerVisual(dataInterval[1], 'color', opts) as ColorString,
            offset: 1
        });

        return colorStops;
    }

    private _createBarPoints(handleEnds: number[], symbolSizes: number[]) {
        const itemSize = this.visualMapModel.itemSize;

        return [
            [itemSize[0] - symbolSizes[0], handleEnds[0]],
            [itemSize[0], handleEnds[0]],
            [itemSize[0], handleEnds[1]],
            [itemSize[0] - symbolSizes[1], handleEnds[1]]
        ];
    }

    private _createBarGroup(itemAlign: helper.ItemAlign) {
        const orient = this._orient;
        const inverse = this.visualMapModel.get('inverse');

        return new graphic.Group(
            (orient === 'horizontal' && !inverse)
            ? {scaleX: itemAlign === 'bottom' ? 1 : -1, rotation: Math.PI / 2}
                : (orient === 'horizontal' && inverse)
            ? {scaleX: itemAlign === 'bottom' ? -1 : 1, rotation: -Math.PI / 2}
                    : (orient === 'vertical' && !inverse)
            ? {scaleX: itemAlign === 'left' ? 1 : -1, scaleY: -1}
            : {scaleX: itemAlign === 'left' ? 1 : -1}
        );
    }

    private _updateHandle(handleEnds: number[], visualInRange: BarVisual) {
        if (!this._useHandle) {
            return;
        }

        const shapes = this._shapes;
        const visualMapModel = this.visualMapModel;
        const handleThumbs = shapes.handleThumbs;
        const handleLabels = shapes.handleLabels;
        const itemSize = visualMapModel.itemSize;
        const dataExtent = visualMapModel.getExtent();
        const align = this._applyTransform('left', shapes.mainGroup);

        each([0, 1], function (handleIndex) {
            const handleThumb = handleThumbs[handleIndex];
            handleThumb.setStyle('fill', visualInRange.handlesColor[handleIndex]);
            handleThumb.y = handleEnds[handleIndex];

            const val = linearMap(handleEnds[handleIndex], [0, itemSize[1]], dataExtent, true);
            const symbolSize = this.getControllerVisual(val, 'symbolSize') as number;

            handleThumb.scaleX = handleThumb.scaleY = symbolSize / itemSize[0];
            handleThumb.x = itemSize[0] - symbolSize / 2;

            // Update handle label position.
            const textPoint = graphic.applyTransform(
                shapes.handleLabelPoints[handleIndex],
                graphic.getTransform(handleThumb, this.group)
            );

            if (this._orient === 'horizontal') {
                // If visualMap controls symbol size, an additional offset needs to be added to labels to avoid collision at minimum size.
                // Offset reaches value of 0 at "maximum" position, so maximum position is not altered at all.
                const minimumOffset = align === 'left' || align === 'top'
                    ? (itemSize[0] - symbolSize) / 2
                    : (itemSize[0] - symbolSize) / -2;

                textPoint[1] += minimumOffset;
            }

            handleLabels[handleIndex].setStyle({
                x: textPoint[0],
                y: textPoint[1],
                text: visualMapModel.formatValueText(this._dataInterval[handleIndex]),
                verticalAlign: 'middle',
                align: this._orient === 'vertical' ? this._applyTransform(
                    'left',
                    shapes.mainGroup
                ) as TextAlign : 'center'
            });
        }, this);
    }

    private _showIndicator(
        cursorValue: number,
        textValue: number,
        rangeSymbol?: string,
        halfHoverLinkSize?: number
    ) {
        const visualMapModel = this.visualMapModel;
        const dataExtent = visualMapModel.getExtent();
        const itemSize = visualMapModel.itemSize;
        const sizeExtent = [0, itemSize[1]];

        const shapes = this._shapes;
        const indicator = shapes.indicator;
        if (!indicator) {
            return;
        }

        indicator.attr('invisible', false);

        const opts = {convertOpacityToAlpha: true};
        const color = this.getControllerVisual(cursorValue, 'color', opts) as ColorString;
        const symbolSize = this.getControllerVisual(cursorValue, 'symbolSize') as number;
        const y = linearMap(cursorValue, dataExtent, sizeExtent, true);
        const x = itemSize[0] - symbolSize / 2;

        const oldIndicatorPos = { x: indicator.x, y: indicator.y };
        // Update handle label position.
        indicator.y = y;
        indicator.x = x;
        const textPoint = graphic.applyTransform(
            shapes.indicatorLabelPoint,
            graphic.getTransform(indicator, this.group)
        );

        const indicatorLabel = shapes.indicatorLabel;
        indicatorLabel.attr('invisible', false);
        const align = this._applyTransform('left', shapes.mainGroup);
        const orient = this._orient;
        const isHorizontal = orient === 'horizontal';
        indicatorLabel.setStyle({
            text: (rangeSymbol ? rangeSymbol : '') + visualMapModel.formatValueText(textValue),
            verticalAlign: isHorizontal ? align as TextVerticalAlign : 'middle',
            align: isHorizontal ? 'center' : align as TextAlign
        });

        const indicatorNewProps = {
            x: x,
            y: y,
            style: {
                fill: color
            }
        };
        const labelNewProps = {
            style: {
                x: textPoint[0],
                y: textPoint[1]
            }
        };

        if (visualMapModel.ecModel.isAnimationEnabled() && !this._firstShowIndicator) {
            const animationCfg = {
                duration: 100,
                easing: 'cubicInOut',
                additive: true
            } as const;
            indicator.x = oldIndicatorPos.x;
            indicator.y = oldIndicatorPos.y;
            indicator.animateTo(indicatorNewProps, animationCfg);
            indicatorLabel.animateTo(labelNewProps, animationCfg);
        }
        else {
            indicator.attr(indicatorNewProps);
            indicatorLabel.attr(labelNewProps);
        }

        this._firstShowIndicator = false;

        const handleLabels = this._shapes.handleLabels;
        if (handleLabels) {
            for (let i = 0; i < handleLabels.length; i++) {
                // Fade out handle labels.
                // NOTE: Must use api enter/leave on emphasis/blur/select state. Or the global states manager will change it.
                this.api.enterBlur(handleLabels[i]);
            }
        }
    }

    private _enableHoverLinkToSeries() {
        const self = this;
        this._shapes.mainGroup

            .on('mousemove', function (e) {
                self._hovering = true;

                if (!self._dragging) {
                    const itemSize = self.visualMapModel.itemSize;
                    const pos = self._applyTransform(
                        [e.offsetX, e.offsetY], self._shapes.mainGroup, true, true
                    );
                    // For hover link show when hover handle, which might be
                    // below or upper than sizeExtent.
                    pos[1] = mathMin(mathMax(0, pos[1]), itemSize[1]);
                    self._doHoverLinkToSeries(
                        pos[1],
                        0 <= pos[0] && pos[0] <= itemSize[0]
                    );
                }
            })

            .on('mouseout', function () {
                // When mouse is out of handle, hoverLink still need
                // to be displayed when realtime is set as false.
                self._hovering = false;
                !self._dragging && self._clearHoverLinkToSeries();
            });
    }

    private _enableHoverLinkFromSeries() {
        const zr = this.api.getZr();

        if (this.visualMapModel.option.hoverLink) {
            zr.on('mouseover', this._hoverLinkFromSeriesMouseOver, this);
            zr.on('mouseout', this._hideIndicator, this);
        }
        else {
            this._clearHoverLinkFromSeries();
        }
    }

    private _doHoverLinkToSeries(cursorPos: number, hoverOnBar?: boolean) {
        const visualMapModel = this.visualMapModel;
        const itemSize = visualMapModel.itemSize;

        if (!visualMapModel.option.hoverLink) {
            return;
        }

        const sizeExtent = [0, itemSize[1]];
        const dataExtent = visualMapModel.getExtent();

        // For hover link show when hover handle, which might be below or upper than sizeExtent.
        cursorPos = mathMin(mathMax(sizeExtent[0], cursorPos), sizeExtent[1]);

        const halfHoverLinkSize = getHalfHoverLinkSize(visualMapModel, dataExtent, sizeExtent);
        const hoverRange = [cursorPos - halfHoverLinkSize, cursorPos + halfHoverLinkSize];
        const cursorValue = linearMap(cursorPos, sizeExtent, dataExtent, true);
        const valueRange = [
            linearMap(hoverRange[0], sizeExtent, dataExtent, true),
            linearMap(hoverRange[1], sizeExtent, dataExtent, true)
        ];
        // Consider data range is out of visualMap range, see test/visualMap-continuous.html,
        // where china and india has very large population.
        hoverRange[0] < sizeExtent[0] && (valueRange[0] = -Infinity);
        hoverRange[1] > sizeExtent[1] && (valueRange[1] = Infinity);

        // Do not show indicator when mouse is over handle,
        // otherwise labels overlap, especially when dragging.
        if (hoverOnBar) {
            if (valueRange[0] === -Infinity) {
                this._showIndicator(cursorValue, valueRange[1], '< ', halfHoverLinkSize);
            }
            else if (valueRange[1] === Infinity) {
                this._showIndicator(cursorValue, valueRange[0], '> ', halfHoverLinkSize);
            }
            else {
                this._showIndicator(cursorValue, cursorValue, '≈ ', halfHoverLinkSize);
            }
        }

        // When realtime is set as false, handles, which are in barGroup,
        // also trigger hoverLink, which help user to realize where they
        // focus on when dragging. (see test/heatmap-large.html)
        // When realtime is set as true, highlight will not show when hover
        // handle, because the label on handle, which displays a exact value
        // but not range, might mislead users.
        const oldBatch = this._hoverLinkDataIndices;
        let newBatch: TargetDataIndices = [];
        if (hoverOnBar || useHoverLinkOnHandle(visualMapModel)) {
            newBatch = this._hoverLinkDataIndices = visualMapModel.findTargetDataIndices(valueRange);
        }

        const resultBatches = modelUtil.compressBatches(oldBatch, newBatch);

        this._dispatchHighDown('downplay', helper.makeHighDownBatch(resultBatches[0], visualMapModel));
        this._dispatchHighDown('highlight', helper.makeHighDownBatch(resultBatches[1], visualMapModel));
    }

    private _hoverLinkFromSeriesMouseOver(e: ElementEvent) {
        let ecData: ECData;

        findEventDispatcher(e.target, target => {
            const currECData = getECData(target);
            if (currECData.dataIndex != null) {
                ecData = currECData;
                return true;
            }
        }, true);

        if (!ecData) {
            return;
        }

        const dataModel = this.ecModel.getSeriesByIndex(ecData.seriesIndex);

        const visualMapModel = this.visualMapModel;
        if (!visualMapModel.isTargetSeries(dataModel)) {
            return;
        }

        const data = dataModel.getData(ecData.dataType);
        const value = data.getStore().get(visualMapModel.getDataDimensionIndex(data), ecData.dataIndex) as number;

        if (!isNaN(value)) {
            this._showIndicator(value, value);
        }
    }

    private _hideIndicator() {
        const shapes = this._shapes;
        shapes.indicator && shapes.indicator.attr('invisible', true);
        shapes.indicatorLabel && shapes.indicatorLabel.attr('invisible', true);

        const handleLabels = this._shapes.handleLabels;
        if (handleLabels) {
            for (let i = 0; i < handleLabels.length; i++) {
                // Fade out handle labels.
                // NOTE: Must use api enter/leave on emphasis/blur/select state. Or the global states manager will change it.
                this.api.leaveBlur(handleLabels[i]);
            }
        }
    }

    private _clearHoverLinkToSeries() {
        this._hideIndicator();

        const indices = this._hoverLinkDataIndices;
        this._dispatchHighDown('downplay', helper.makeHighDownBatch(indices, this.visualMapModel));

        indices.length = 0;
    }

    private _clearHoverLinkFromSeries() {
        this._hideIndicator();

        const zr = this.api.getZr();

        zr.off('mouseover', this._hoverLinkFromSeriesMouseOver);
        zr.off('mouseout', this._hideIndicator);
    }
    private _applyTransform(vertex: number[], element: Element, inverse?: boolean, global?: boolean): number[]
    private _applyTransform(vertex: Direction, element: Element, inverse?: boolean, global?: boolean): Direction
    private _applyTransform(
        vertex: number[] | Direction,
        element: Element,
        inverse?: boolean,
        global?: boolean
    ) {
        const transform = graphic.getTransform(element, global ? null : this.group);

        return zrUtil.isArray(vertex)
            ? graphic.applyTransform(vertex, transform, inverse)
            : graphic.transformDirection(vertex, transform, inverse);
    }

    // TODO: TYPE more specified payload types.
    private _dispatchHighDown(type: 'highlight' | 'downplay', batch: Payload['batch']) {
        batch && batch.length && this.api.dispatchAction({
            type: type,
            batch: batch
        });
    }

    /**
     * @override
     */
    dispose() {
        this._clearHoverLinkFromSeries();
        this._clearHoverLinkToSeries();
    }

    /**
     * @override
     */
    renderForEstimate(visualMapModel: ContinuousModel, ecModel: GlobalModel, api: ExtensionAPI): ZRRectLike {
        // 如果视觉映射组件设置为不显示，则直接返回空尺寸防止后续布局异常
        if (visualMapModel.get('show') === false) {
            return { x: 0, y: 0, width: 0, height: 0 };
        }

        // 创建一个临时 graphic.Group 用于测量尺寸
        const tempGroup = new graphic.Group();

        // 保存当前实例里 shapes 及 visualMapModel 状态，避免临时对象影响业务状态
        const originalShapes = this._shapes;
        const originalVisualMapModel = this.visualMapModel;
        const tempShapes = {} as ShapeStorage;

        try {
            // 切换到估算状态，使用临时 shape 存储及 model
            this._shapes = tempShapes;
            this.visualMapModel = visualMapModel;

            // 方向和是否可拖拽 handle 的模式，也需要在估算期间同步
            this._orient = visualMapModel.get('orient');
            this._useHandle = visualMapModel.get('calculable');

            this._resetInterval();

            // 封装主元素的生成流程（如 bar、文本、indicator 都使用透明色，仅供估算尺寸）
            this._renderBarForEstimate(tempGroup);

            // 构造两端 value 文本，实际用于测量上下/左右的文本所需空间
            const dataRangeText = visualMapModel.get('text');
            this._renderEndsTextForEstimate(tempGroup, dataRangeText, 0);
            this._renderEndsTextForEstimate(tempGroup, dataRangeText, 1);

            // 强制刷新视图布局，仅更新包围盒信息，不实际绘制
            this._updateViewForEstimate(tempGroup, true);

            // 获取完整 layout 区域并附加 padding
            const layoutRect = tempGroup.getBoundingRect();
            return applyPaddingToRect(layoutRect, visualMapModel);
        }
        finally {
            // 始终恢复组件本身的 shapes 及 visualMapModel，确保后续真实渲染不受影响
            this._shapes = originalShapes;
            this.visualMapModel = originalVisualMapModel;
        }
    }

    /**
     * 生成估算用的 bar 区域及结构。
     *
     * 仅用于尺寸估算，所有实际图形均为透明且不会参与渲染，主要模拟实际组件结构以获得精确尺寸。
     */
    private _renderBarForEstimate(targetGroup: graphic.Group) {
        const visualMapModel = this.visualMapModel;
        const shapes = this._shapes;
        const itemSize = visualMapModel.itemSize;
        const orient = this._orient;
        const useHandle = this._useHandle;
        // 计算 bar 的对齐方式，确保布局估算和最终视图保持一致
        const itemAlign = helper.getItemAlign(visualMapModel, this.api, itemSize);
        // 创建主 bar group 以对齐位置
        const mainGroup = shapes.mainGroup = this._createBarGroup(itemAlign);

        // bar 上绘制渐变色的 group，这里透明化仅用于预估
        const gradientBarGroup = new graphic.Group();
        mainGroup.add(gradientBarGroup);

        // 创建主 bar 的“无效范围”多边形，设置为透明，实际只需其形状数据用于布局测量
        const outOfRangePolygon = createPolygon();
        outOfRangePolygon.setStyle({
            fill: 'transparent'
        });
        shapes.outOfRange = outOfRangePolygon;
        gradientBarGroup.add(outOfRangePolygon);

        // 配合圆角、bar 区域采用 clipPath 进一步拟合实际展示尺寸（clip 防溢出）
        gradientBarGroup.setClipPath(new graphic.Rect({
            shape: {
                x: 0,
                y: 0,
                width: itemSize[0],
                height: itemSize[1],
                r: 3
            }
        }));

        // 测试性用一个汉字，来评估 label 的最大高度/宽度，确保后续布局空间充足
        const textRect = visualMapModel.textStyleModel.getTextRect('国');
        const textSize = mathMax(textRect.width, textRect.height);

        // 如果支持拖动 handle，则也创建透明 handle。数组初始化防止读取时不报错。
        if (useHandle) {
            shapes.handleThumbs = [];
            shapes.handleLabels = [];
            shapes.handleLabelPoints = [];

            this._createHandleForEstimate(
                visualMapModel, targetGroup, mainGroup, 0, itemSize, textSize, orient
            );
            this._createHandleForEstimate(
                visualMapModel, targetGroup, mainGroup, 1, itemSize, textSize, orient
            );
        }

        // 创建一个透明的 indicator 元素，用于占据实际情况下 indicator 需要的几何位置
        this._createIndicatorForEstimate(visualMapModel, targetGroup, mainGroup, itemSize, textSize, orient);

        // 最后将构造好的完整 group 挂到临时 group，便于统一 bbox 测算
        targetGroup.add(mainGroup);
    }

    /**
     * 生成 estimate 专用的 handle（拖拽操作点），只涉及布局不涉及事件或实际交
     * 互。
     *
     * 该 handle 的样式均为透明，仅为测量其尺寸和占位。
     */
    private _createHandleForEstimate(
        visualMapModel: ContinuousModel,
        group: graphic.Group,
        mainGroup: graphic.Group,
        handleIndex: 0 | 1,
        itemSize: number[],
        textSize: number,
        orient: Orient
    ) {
        // 计算 handle 大小，可为百分比类型
        const handleSize = parsePercent(visualMapModel.get('handleSize'), itemSize[0]);
        // 创建 handle 的形状，仅透明填充，不参与渲染
        const handleThumb = createSymbol(
            visualMapModel.get('handleIcon'),
            -handleSize / 2, -handleSize / 2, handleSize, handleSize,
            null, true
        );
        handleThumb.attr({
            silent: true,
            invisible: true,
            x: itemSize[0] / 2
        });
        handleThumb.x = itemSize[0] / 2;
        (handleThumb as graphic.Path).setStyle({
            strokeNoScale: true,
            strokeFirst: true
        });
        (handleThumb as graphic.Path).style.lineWidth *= 2;

        // 仅结构性挂载至主 group，真实布局只考虑空间
        mainGroup.add(handleThumb);

        // handle 上的值文本，依然采用透明，仅用于占位
        const textStyleModel = this.visualMapModel.textStyleModel;
        const handleLabelStyle = createTextStyle(textStyleModel, {
            x: 0,
            y: 0,
            text: ''
        });
        handleLabelStyle.fill = 'transparent';
        handleLabelStyle.opacity = 0;
        const handleLabel = new graphic.Text({
            style: handleLabelStyle
        });
        group.add(handleLabel);

        // handle label 的参考点，用于后续定位
        const handleLabelPoint = [handleSize, 0];

        // 塞到 shapes 里面保持一致结构，便于后续访问
        const shapes = this._shapes;
        shapes.handleThumbs[handleIndex] = handleThumb;
        shapes.handleLabelPoints[handleIndex] = handleLabelPoint;
        shapes.handleLabels[handleIndex] = handleLabel;
    }

    /**
     * 生成 estimate 专用的 indicator 及其文本，仅用于占位和尺寸预估。
     *
     * indicator 用于鼠标悬浮值显示，与 handle 固定在主 group 上。
     */
    private _createIndicatorForEstimate(
        visualMapModel: ContinuousModel,
        group: graphic.Group,
        mainGroup: graphic.Group,
        itemSize: number[],
        textSize: number,
        orient: Orient
    ) {
        // 计算指示器的大小（可能与 bar 宽度成比例）
        const scale = parsePercent(visualMapModel.get('indicatorSize'), itemSize[0]);
        // 指示器主体，透明不可见
        const indicator = createSymbol(
            visualMapModel.get('indicatorIcon'),
            -scale / 2, -scale / 2, scale, scale,
            null, true
        );
        indicator.attr({
            silent: true,
            invisible: true,
            x: itemSize[0] / 2
        });
        indicator.setStyle({
            fill: 'transparent',
            opacity: 0
        });

        mainGroup.add(indicator);

        // 指示器上的 label，也做透明填充，避免影响主题布局
        const textStyleModel = this.visualMapModel.textStyleModel;
        const indicatorLabel = new graphic.Text({
            silent: true,
            invisible: true,
            style: createTextStyle(textStyleModel, {
                x: 0,
                y: 0,
                text: ''
            })
        });
        indicatorLabel.setStyle({
            fill: 'transparent',
            opacity: 0
        });
        group.add(indicatorLabel);

        // 计算 label 的挂载基准点 —— 水平方向右移一定距离，竖直方向直接顶上
        const indicatorLabelPoint = [
            (orient === 'horizontal' ? textSize / 2 : HOVER_LINK_OUT) + itemSize[0] / 2,
            0
        ];
        const shapes = this._shapes;
        shapes.indicator = indicator;
        shapes.indicatorLabel = indicatorLabel;
        shapes.indicatorLabelPoint = indicatorLabelPoint;

        // 标记下一次显示 indicator 时需要特殊处理
        this._firstShowIndicator = true;
    }

    /**
     * 生成 estimate 状态下的两端文本（最大最小值说明）。
     *
     * 注意：这里只用于布局测量，不做可见文本渲染。
     */
    private _renderEndsTextForEstimate(
        group: graphic.Group,
        dataRangeText: string[],
        endsIndex: 0 | 1,
    ) {
        // 估算场景下，只有配了文本才进行尺寸测量
        if (!dataRangeText) {
            return;
        }
        const visualMapModel = this.visualMapModel;
        // 兼容旧版本 text 配置顺序问题：高值放前、低值放后
        let text = dataRangeText[1 - endsIndex];
        text = text != null ? text + '' : '';

        const textGap = visualMapModel.get('textGap');
        const itemSize = visualMapModel.itemSize;

        // 拿到 bar 的参照 group，方便变换坐标求具体布局点
        const barGroup = this._shapes.mainGroup;
        const position = this._applyTransform(
            [
                itemSize[0] / 2,
                endsIndex === 0 ? -textGap : itemSize[1] + textGap
            ],
            barGroup
        ) as number[];
        const orient = this._orient;
        const textStyleModel = this.visualMapModel.textStyleModel;

        // 添加透明文本 shape，仅用于触发布局和占位
        group.add(new graphic.Text({
            silent: true,
            invisible: true,
            style: createTextStyle(textStyleModel, {
                x: position[0],
                y: position[1],
                // 自动适配方向和对齐规则，使布局逼近真实渲染
                verticalAlign: textStyleModel.get('verticalAlign')
                    || (orient === 'horizontal' ? 'middle' : (endsIndex === 0 ? 'bottom' : 'top') as TextVerticalAlign),
                align: textStyleModel.get('align')
                    || (orient === 'horizontal' ? (endsIndex === 0 ? 'bottom' : 'top') as TextAlign : 'center'),
                text,
                fill: 'transparent',
                opacity: 0
            })
        }));
    }

    /**
     * 仅在“估算模式”下，根据当前 layout 刷新元素的位置数据（不设置颜色等样
     * 式）。
     *
     * 用于保障尺寸测量准确性。注意不会写入实际的 color, gradient 等样式。
     */
    private _updateViewForEstimate(group: graphic.Group, forSketch?: boolean) {
        const visualMapModel = this.visualMapModel;
        const dataExtent = visualMapModel.getExtent();
        const shapes = this._shapes;

        // 计算两个极值位置，便于估算整体长度
        const outOfRangeHandleEnds = [0, visualMapModel.itemSize[1]];
        // 若仅估算 sketch，则 handle 在极端边界；否则采用当前已有的 handle 区间
        const inRangeHandleEnds = forSketch ? outOfRangeHandleEnds : this._handleEnds;

        // 生成 inRange / outOfRange bar points 数据，但不设置真实样式，仅填形状
        const visualInRange = this._createBarVisual(
            this._dataInterval, dataExtent, inRangeHandleEnds, 'inRange'
        );
        const visualOutOfRange = this._createBarVisual(
            dataExtent, dataExtent, outOfRangeHandleEnds, 'outOfRange'
        );

        // 只更改透明 shape 的几何区域，不做其他布局处理
        shapes.outOfRange.setShape('points', visualOutOfRange.barPoints);

        // 触发 handle 的同步位置调整
        this._updateHandleForEstimate(group, inRangeHandleEnds, visualInRange);
    }

    /**
     * 在 estimate 模式下同步更新 handles 的布局逻辑（位置、缩放、文本等），不改
     * 变颜色样式。
     *
     * 此方法只处理 handle 及其 label 的物理几何属性，用于空间测算。
     */
    private _updateHandleForEstimate(group: graphic.Group, handleEnds: number[], visualInRange: BarVisual) {
        if (!this._useHandle) {
            return;
        }

        const shapes = this._shapes;
        const visualMapModel = this.visualMapModel;
        const handleThumbs = shapes.handleThumbs;
        const handleLabels = shapes.handleLabels;
        const itemSize = visualMapModel.itemSize;
        const dataExtent = visualMapModel.getExtent();

        each([0, 1], function (handleIndex) {
            // 更新 handle 的 y 坐标，仅用于竖直方向定位，或者水平时 x 匹配
            const handleThumb = handleThumbs[handleIndex];
            handleThumb.y = handleEnds[handleIndex];

            // 通过 handle 的位置反算出当前数值
            const val = linearMap(handleEnds[handleIndex], [0, itemSize[1]], dataExtent, true);
            // 获取 handle 对应的符号实际尺寸，使布局与缩放等比例相关
            const symbolSize = this.getControllerVisual(val, 'symbolSize') as number;

            handleThumb.scaleX = handleThumb.scaleY = symbolSize / itemSize[0];
            handleThumb.x = itemSize[0] - symbolSize / 2;

            // 根据变换后的位置，计算 label 的精确绘制点
            const textPoint = graphic.applyTransform(
                shapes.handleLabelPoints[handleIndex],
                graphic.getTransform(handleThumb, group)
            );

            // 对于横向 visualMap，label 位置按主 bar 对齐方向偏移
            if (this._orient === 'horizontal') {
                const align = this._applyTransform('left', shapes.mainGroup);
                const minimumOffset = align === 'left' || align === 'top'
                    ? (itemSize[0] - symbolSize) / 2
                    : (itemSize[0] - symbolSize) / -2;
                textPoint[1] += minimumOffset;
            }

            // 更新 label 的 layout 信息，保持 estimate 态下 label 也能正确计入 bbox
            handleLabels[handleIndex].setStyle({
                x: textPoint[0],
                y: textPoint[1],
                text: visualMapModel.formatValueText(this._dataInterval[handleIndex]),
                verticalAlign: 'middle',
                align: this._orient === 'vertical' ? this._applyTransform(
                    'left',
                    shapes.mainGroup
                ) as TextAlign : 'center'
            });
        }, this);
    }

}

function createPolygon(
    points?: number[][],
    cursor?: string,
    onDrift?: (x: number, y: number) => void,
    onDragEnd?: () => void
) {
    return new graphic.Polygon({
        shape: {points: points},
        draggable: !!onDrift,
        cursor: cursor,
        drift: onDrift,
        onmousemove(e) {
            // For mobile device, prevent screen slider on the button.
            eventTool.stop(e.event);
        },
        ondragend: onDragEnd
    });
}

function getHalfHoverLinkSize(visualMapModel: ContinuousModel, dataExtent: number[], sizeExtent: number[]) {
    let halfHoverLinkSize = HOVER_LINK_SIZE / 2;
    const hoverLinkDataSize = visualMapModel.get('hoverLinkDataSize');
    if (hoverLinkDataSize) {
        halfHoverLinkSize = linearMap(hoverLinkDataSize, dataExtent, sizeExtent, true) / 2;
    }
    return halfHoverLinkSize;
}

function useHoverLinkOnHandle(visualMapModel: ContinuousModel) {
    const hoverLinkOnHandle = visualMapModel.get('hoverLinkOnHandle');
    return !!(hoverLinkOnHandle == null ? visualMapModel.get('realtime') : hoverLinkOnHandle);
}

function getCursor(orient: Orient) {
    return orient === 'vertical' ? 'ns-resize' : 'ew-resize';
}

export default ContinuousView;
