/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.
*/
/**
 * 自动布局系统模块
 *
 * 该模块实现了 ECharts 的智能自动布局功能，主要解决图例、visualMap 等组件
 * 与坐标系、系列之间的布局冲突问题。通过智能的空间计算和调整算法，实现：
 *
 * 1. 图例避让：自动为图例组件让出合适的空间，避免遮挡坐标系内容
 * 2. 坐标系压缩：当图例占用过多空间时，自动压缩坐标系绘制区域
 * 3. 系列布局：处理无坐标系系列（如饼图）的布局需求
 * 4. 标签边界计算：精确计算各类标签元素的边界矩形，用于布局决策
 * 5. 符号尺寸估算：为数据点符号提供精确的边界计算
 *
 * 主要使用场景：
 * - 图例自动定位：根据位置配置智能选择最佳布局策略
 * - 多组件协同：处理图例、visualMap 等多个组件的协同布局
 * - 响应式布局：窗口大小变化时自动重新计算布局
 * - 复杂图表布局：处理包含标记线、标记点等复杂元素的图表
 *
 * 设计原则：
 * - 非侵入性：不改变现有组件的正常渲染逻辑
 * - 性能优化：通过缓存和增量计算减少重复布局开销
 * - 向后兼容：保持现有配置和 API 的完全兼容性
 * - 扩展性：支持新的坐标系和组件类型
 *
 * @module util/autoLayout
 */
import type GlobalModel from '../model/Global';
import type ExtensionAPI from '../core/ExtensionAPI';
import type { BoxLayoutOptionMixin, ComponentOption, ZRRectLike } from './types';
import type LegendModel from '../component/legend/LegendModel';
// eslint-disable-next-line no-duplicate-imports
import type { LegendOption } from '../component/legend/LegendModel';
import type VisualMapModel from '../component/visualMap/VisualMapModel';
// eslint-disable-next-line no-duplicate-imports
import type { VisualMapOption } from '../component/visualMap/VisualMapModel';
import * as zrUtil from 'zrender/src/core/util';
import * as graphic from './graphic';
import * as formatUtil from './format';
import { createTextStyle, getLabelStatesModels } from '../label/labelStyle';
import type Model from '../model/Model';
import type ComponentModel from '../model/Component';
import type ComponentView from '../view/Component';
import tokens from '../visual/tokens';
import type { CoordinateSystemMaster } from '../coord/CoordinateSystem';
import { BoundingRect, RectLike } from 'zrender';
import { calculateTextPosition, TextPositionCalculationResult } from 'zrender/src/contain/text';
import type SeriesModel from '../model/Series';
import type SeriesData from '../data/SeriesData';
import type ChartView from '../view/Chart';
import * as symbolUtil from './symbol';
import type Axis from '../coord/Axis';
import type { AxisBuilderSharedContext } from '../component/axis/AxisBuilder';
import MarkerModel from '../component/marker/MarkerModel';
import type MarkLineView from '../component/marker/MarkLineView';
import type MarkLineModel from '../component/marker/MarkLineModel';
import type MarkPointModel from '../component/marker/MarkPointModel';
import type MarkPointView from '../component/marker/MarkPointView';
// eslint-disable-next-line no-duplicate-imports
import { computeLabelGeometry } from '../label/labelLayoutHelper';
// eslint-disable-next-line no-duplicate-imports
import type { LabelGeometry, LabelLayoutData } from '../label/labelLayoutHelper';
import ZRText from 'zrender/src/graphic/Text';
import type { BuiltinTextPosition } from 'zrender/src/core/types';

const each = zrUtil.each;

/**
 * 默认图例布局配置。
 *
 * 定义了图例组件布局时的标准间距配置，用于确保组件之间的视觉平衡。
 * 这些值基于设计系统中的标准尺寸 tokens，保证了界面的一致性。
 *
 * 使用场景：
 * - 多图例组件的间距计算
 * - 组件与坐标系边界的距离控制
 * - 提供合理的默认布局参数
 */
const DEFAULT_LEGEND_LAYOUT_CONFIG = {
    margin: tokens.size.s, // 组件和内容区域的间距（10px）
    itemGap: tokens.size.xxs, // 组件间的间距（2px）
};

/**
 * 默认的标签几何计算选项。
 *
 * 控制标签边界矩形计算时的边距策略，用于避免标签与图表元素过于靠近。
 * 通过最小强制边距和默认边距的组合，实现精确的布局控制。
 *
 * 参数说明：
 * - minMarginForce: [top, right, bottom, left] 最小强制边距，null 表示不强制
 * - marginDefault: 默认边距值，当未指定时使用
 *
 * 设计意图：
 * - 确保标签有足够的可读空间
 * - 避免标签与数据点或其他元素重叠
 * - 提供灵活的边距控制机制
 */
export const DEFAULT_LABEL_GEOMETRY_OPT = {
    minMarginForce: [null, 0, null, 0] as (number | null)[],
    marginDefault: [1, 0, 1, 0] as number[]
};

/**
 * 图例布局方向类型。
 *
 * 控制图例组件的排列方向，影响布局算法和空间计算策略。
 * - horizontal: 水平排列，适用于上下位置的图例
 * - vertical: 垂直排列，适用于左右位置的图例
 */
type LegendLayoutOrient = 'horizontal' | 'vertical';

/**
 * 图例布局对齐方式类型。
 *
 * 定义组件在布局容器中的对齐方式，影响最终的定位计算。
 * - start: 前对齐（水平布局时左对齐，垂直布局时上对齐）
 * - center: 居中对齐
 * - end: 后对齐（水平布局时右对齐，垂直布局时下对齐）
 */
type LegendLayoutAlign = 'start' | 'center' | 'end';

/**
 * 图例布局分组集合类型。
 *
 * 按位置分组的图例组件集合，每个位置（如 'top'、'bottom' 等）对应一个分组。
 * 用于处理多组件协同布局的场景，保证相同位置的组件能够合理排列。
 */
export type LayoutLegendGroups = Record<string, LayoutLegendGroup>;

/**
 * 自动布局图例配置选项接口。
 *
 * 扩展基础组件配置，添加自动布局相关的配置项。
 * 通过这些配置，用户可以控制图例组件的自动定位和布局行为。
 *
 * 设计意图：
 * - 提供声明式的布局配置接口
 * - 支持多组件协同布局场景
 * - 保持与现有配置系统的兼容性
 */
export interface AutoLayoutLegendOption extends ComponentOption {
    /**
     * 自动布局配置选项。
     *
     * 当启用时，组件将参与自动布局系统，由系统智能计算其位置和尺寸。
     * 支持的位置包括画布的四个边，系统会根据可用空间自动调整布局。
     */
    autoLayout?: {
        /**
         * 是否启用自动布局。
         */
        enable?: boolean;
        /**
         * 自动布局位置。
         *
         * - 'top'：水平布局且位于画布顶部'
         * - 'bottom': 水平布局且位于画布底部
         * - 'left'：垂直布局且位于画布左侧
         * - 'right'：垂直布局且位于画布右侧
         * 注意：相同的position只用在第一个组件上配置align和layoutMode就行了。
         */
        position?: 'top' | 'bottom' | 'left' | 'right';
        /**
         * 自动布局对齐方式。
         *
         * - 'start': 前对齐（水平布局时左对齐，垂直布局时上对齐）
         * - 'center': 居中对齐（默认）
         * - 'end': 后对齐（水平布局时右对齐，垂直布局时下对齐）
         */
        align?: LegendLayoutAlign;
        /**
         * 多组件布局模式。
         *
         * - 'singleLine': 所有组件在一行/列显示
         * - 'multiLine': 每个组件单独一行/列（默认）
         *
         * 注意：当layoutMode为'singleLine'时，需要将type设置为 'scroll'，才能做
         * 到当组件宽度超出容器宽度时自动出现滚动条。
         */
        layoutMode?: 'singleLine' | 'multiLine';
        /**
         * 组件和内容区域的间距。
         *
         * 默认值：tokens.size.s (10px)
         */
        margin?: number;
        /**
         * 组件间的间距。
         *
         * 默认值：tokens.size.xxs (2px)
         */
        itemGap?: number;
    };

    /**
     * 最小尺寸。
     */
    minSize?: { width?: number; height?: number };
    /**
     * 最大尺寸。
     */
    maxSize?: { width?: number; height?: number };
}

/**
 * 可进行自动布局模式渲染的组件视图接口。
 *
 * 实现此接口的组件视图能够提供精确的尺寸估算能力，这是自动布局系统的核心能力之一。
 * 通过估算模式渲染，可以在不实际绘制的情况下获得组件的精确尺寸。
 *
 * 实现要求：
 * - 必须提供 renderForEstimate 方法的实现
 * - 估算结果应尽可能接近实际渲染尺寸
 * - 支持所有配置选项下的尺寸估算
 *
 * 适用组件：
 * - 图例组件 (Legend)
 * - 视觉映射组件 (VisualMap)
 * - 其他需要自动布局的组件
 */
export interface AutoLayoutComponentView extends ComponentView {
    /**
     * 执行估算模式渲染，用于计算组件在当前配置下的精确尺寸。
     *
     * 此方法不会实际绘制组件到画布，而是创建一个虚拟的渲染过程来获得尺寸信息。
     * 自动布局系统依赖此方法来预先计算空间需求，避免布局冲突。
     *
     * @param model 组件模型，包含当前的配置选项
     * @param ecModel 全局模型，用于访问其他组件的状态
     * @param api 扩展API，用于访问渲染环境信息
     * @returns 组件的边界矩形，包含宽度和高度信息
     */
    renderForEstimate(model: ComponentModel, ecModel: GlobalModel, api: ExtensionAPI): ZRRectLike;
}

/**
 * 可进行自动布局的组件模型接口。
 *
 * 实现此接口的组件模型能够接收自动布局系统计算出的布局参数。
 * 通过 setAutoLayoutBoxParams 方法，布局系统可以将计算结果应用到组件上。
 *
 * 设计意图：
 * - 解耦布局计算和组件渲染
 * - 支持动态布局调整
 * - 保持组件内部状态的一致性
 */
export interface AutoLayoutComponentModel extends ComponentModel<AutoLayoutLegendOption> {
    /**
     * 设置自动布局计算出的盒模型参数。
     *
     * 布局系统通过此方法将计算出的位置和尺寸信息传递给组件。
     * 组件应该根据这些参数调整自身的布局状态。
     *
     * @param boxParams 包含位置和尺寸信息的盒模型参数
     */
    setAutoLayoutBoxParams(boxParams: BoxLayoutOptionMixin): void;
}

/**
 * 自动布局组件分组信息接口。
 *
 * 表示一组在相同位置进行协同布局的组件集合。
 * 分组是自动布局系统的基本计算单元，系统按位置将组件分组后分别处理。
 *
 * 分组生命周期：
 * 1. 收集阶段：根据位置配置将组件分配到对应分组
 * 2. 计算阶段：计算分组所需的空间和布局参数
 * 3. 应用阶段：将计算结果应用到分组内的所有组件
 *
 * 设计意图：
 * - 支持多组件在同一位置的协同布局
 * - 提供统一的布局策略配置
 * - 隔离不同位置的布局计算
 */
interface LayoutLegendGroup {
    /**
     * 分组的唯一标识符。
     *
     * 通常使用位置字符串作为标识，如 'top'、'bottom' 等。
     */
    id: string;
    /**
     * 组件组的基础位置。
     *
     * 决定了布局的基准方向和坐标系。
     */
    position: 'bottom' | 'top' | 'left' | 'right';
    /**
     * 布局方向，由位置自动推断得出。
     *
     * - top/bottom 位置：horizontal
     * - left/right 位置：vertical
     */
    orient: LegendLayoutOrient;
    /**
     * 组件组的对齐方式。
     *
     * 影响所有组件在布局容器中的排列方式。
     */
    align: LegendLayoutAlign;
    /**
     * 多组件布局模式。
     *
     * - singleLine: 所有组件在一行/列显示
     * - multiLine: 每个组件单独一行/列
     */
    layoutMode: 'singleLine' | 'multiLine';
    /**
     * 组件组与坐标系的间距。
     *
     * 控制组件距离绘图区域的距离。
     */
    margin: number;
    /**
     * 组内组件之间的间距。
     *
     * 影响组件间的视觉分离度。
     */
    itemGap: number;
    /**
     * 分组内的组件列表。
     *
     * 包含所有参与此分组布局的组件信息。
     */
    items: LayoutLegendGroupItem[];
    /**
     * 目标坐标系的外边界矩形。
     *
     * 用于最终的布局位置计算，包含坐标系及其标签的完整边界。
     */
    targetRect?: RectLike | null;
}

/**
 * 自动布局组件分组项接口。
 *
 * 表示分组中的单个组件信息，包含布局计算所需的所有数据。
 * 每个分组项都包含组件模型和布局相关的元数据。
 */
interface LayoutLegendGroupItem {
    /**
     * 组件的模型实例。
     *
     * 用于访问组件的配置和状态信息。
     */
    model: AutoLayoutComponentModel;
    /**
     * 是否为可滚动组件。
     *
     * 滚动组件在布局计算中可能有不同的权重和行为。
     */
    scroll: boolean;
    /**
     * 组件的估算尺寸。
     *
     * 通过估算渲染获得，用于布局空间计算。
     */
    estimatedSize: { width: number; height: number };
}

/**
 * 图例自动布局上下文接口。
 *
 * 封装了自动布局过程中的状态信息和中间结果。
 * 上下文在布局计算的不同阶段传递，用于协调组件与坐标系之间的布局调整。
 *
 * 上下文生命周期：
 * 1. 初始化：创建基础上下文，设置布局需求
 * 2. 计算阶段：填充分组信息和边距调整
 * 3. 应用阶段：传递最终的边界矩形信息
 *
 * 设计意图：
 * - 提供布局状态的统一管理
 * - 支持布局计算的中间结果传递
 * - 解耦布局逻辑和组件实现
 */
export interface LayoutLegendContext {
    /**
     * 是否需要执行完整的布局计算。
     *
     * - true: 需要计算组件位置和尺寸，进行完整的布局流程
     * - false: 只需使用预计算的边距调整坐标系空间，无需重新布局组件
     *
     * 这种区分允许在不同场景下使用不同的优化策略。
     */
    needLayout: boolean;
    /**
     * 关联的组件分组信息。
     *
     * 当 needLayout 为 true 时，此字段包含布局计算所需的组件分组数据。
     */
    group?: LayoutLegendGroup;
    /**
     * 用于调整坐标系空间的边距数组。
     *
     * 格式：[top, right, bottom, left]，表示四个方向需要压缩的空间大小。
     * 当图例组件占用过多空间时，通过此边距通知坐标系进行空间调整。
     */
    margin?: number[];
    /**
     * 应用布局调整后的最终边界矩形。
     *
     * 包含坐标系及其所有标签（如轴标签）的完整边界。
     * 用于后续布局计算和组件避让逻辑的参考。
     */
    finalBoundingRect?: RectLike | null;
}

/**
 * 支持图例避让的坐标系统接口。
 *
 * 扩展基础坐标系统接口，添加自动布局相关的能力。
 * 实现此接口的坐标系统能够感知图例布局的变化，并相应调整自身的绘制区域。
 *
 * 主要能力：
 * - 提供外边界矩形查询
 * - 支持自动布局调整应用
 * - 维护布局上下文状态
 *
 * 适用坐标系：
 * - Grid: 笛卡尔坐标系，支持四边空间调整
 * - Radar: 雷达坐标系，支持中心点和半径调整
 * - Polar: 极坐标系，支持极点和半径调整
 */
export interface LegendAvoidableCoordinateSystem extends CoordinateSystemMaster {
    /**
     * 自动布局上下文状态。
     *
     * 存储当前坐标系的布局调整信息，由自动布局管理器维护。
     * 坐标系实现者不应直接修改此字段。
     */
    autoLayoutContext?: LayoutLegendContext | undefined;
    /**
     * 获取坐标系的外边界矩形。
     *
     * 返回坐标系的完整绘制区域，包括所有必要的边距和标签空间。
     * 此边界将作为图例避让计算的参考基准。
     *
     * @returns 坐标系的外边界矩形，包含位置和尺寸信息；如果无法计算则返回 null
     */
    getOuterBoundingRect?(): RectLike | null;
    /**
     * 应用自动布局调整。
     *
     * 根据 autoLayoutContext 中的信息，调整坐标系的绘制参数。
     * 实现者需要根据上下文中的边距信息调整坐标系的实际绘制区域。
     *
     * @param ecModel 全局模型，包含所有组件的状态
     * @param api 扩展API，用于访问渲染环境和触发重绘
     */
    applyAutoLayout?(ecModel: GlobalModel, api: ExtensionAPI): void;
}

/**
 * 支持图例避让的系列视图接口。
 *
 * 扩展基础图表视图接口，为无坐标系的系列（如饼图、漏斗图等）提供自动布局能力。
 * 这些系列虽然没有固定的坐标系，但仍然需要在图例布局时进行空间调整。
 *
 * 主要能力：
 * - 提供系列的外边界矩形查询
 * - 维护自动布局上下文状态
 * - 支持布局调整的动态应用
 *
 * 适用系列类型：
 * - Pie: 饼图系列
 * - Funnel: 漏斗图系列
 * - Tree: 树图系列
 * - Treemap: 矩形树图系列
 */
export interface LegendAvoidableSeriesView extends ChartView {
    /**
     * 自动布局上下文状态。
     *
     * 存储当前系列的布局调整信息，由自动布局管理器设置和维护。
     * 系列视图使用此上下文来调整自身的绘制参数。
     */
    autoLayoutContext: LayoutLegendContext | undefined;
    /**
     * 获取系列的完整外边界矩形。
     *
     * 返回系列的绘制区域，包括所有可视元素（如图形、标签、标记线等）的边界。
     * 此边界信息用于计算图例布局时的避让空间。
     *
     * @param seriesModel 当前系列的模型实例
     * @param ecModel 全局模型，用于访问其他组件状态
     * @param api 扩展API，用于访问渲染环境信息
     * @param payload 额外的负载数据，可能包含动画或交互状态
     * @returns 系列的外边界矩形；如果系列当前无绘制内容则返回 null
     */
    getOuterBoundingRect(
        seriesModel: SeriesModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: any
    ): BoundingRect | null;
}

/**
 * 符号边界矩形提供者接口。
 *
 * 为图表视图提供精确的符号（数据点图形）边界矩形查询能力。
 * 实现此接口的视图能够为每个数据点提供精确的符号边界，用于标签定位和布局计算。
 *
 * 设计意图：
 * - 支持复杂符号类型的精确边界计算
 * - 为标签自动避让提供精确的参考位置
 * - 处理特殊符号类型（如 pin、arrow）的边界计算
 *
 * 适用场景：
 * - 散点图中的自定义符号
 * - 带有复杂图形的标记点
 * - 需要精确标签定位的图表类型
 */
export interface SymbolRectProvider {
    /**
     * 获取指定数据点的符号边界矩形。
     *
     * 返回数据点符号的精确边界，用于标签定位和避让计算。
     * 支持标准符号类型和自定义符号的边界计算。
     *
     * @param seriesModel 系列模型，用于访问系列配置
     * @param dataIndex 数据点的索引位置
     * @param ecModel 全局模型，用于访问视觉映射等配置
     * @returns 符号的边界矩形；如果该点无符号或无法计算则返回 null
     */
    getSymbolRect(
        seriesModel: SeriesModel,
        dataIndex: number,
        ecModel: GlobalModel
    ): BoundingRect | null;
}

/**
 * 标签边界矩形计算属性接口。
 *
 * 定义了计算标签边界矩形时所需的完整属性集合。
 * 这些属性涵盖了标签定位、样式和几何变换的所有方面。
 */
export interface LabelBoundingRectProps {
    /**
     * 文本水平对齐方式。
     */
    align?: string;
    /**
     * 文本垂直对齐方式。
     */
    verticalAlign?: string;
    /**
     * 标签文本。
     */
    text: string;
    /**
     * 标签 x 坐标。
     */
    x: number;
    /**
     * 标签 y 坐标。
     */
    y: number;
    /**
     * 旋转角度（可选，默认 0）。
     */
    rotation?: number;
    /**
     * 旋转原点 x 坐标（可选，如果不提供则默认使用 x）。
     */
    originX?: number;
    /**
     * 旋转原点 y 坐标（可选，如果不提供则默认使用 y）。
     */
    originY?: number;
}

/**
 * 标记标签边界矩形计算的属性对象。
 */

/**
 * 图例自动布局管理器类。
 *
 * 负责协调和管理整个图例自动布局系统的核心逻辑。
 * 该管理器实现了从组件收集、空间计算、布局调整到最终应用的完整流程。
 *
 * 主要职责：
 * 1. 组件收集：识别和分组所有启用了自动布局的组件
 * 2. 空间计算：计算组件布局所需的空间和坐标系调整需求
 * 3. 布局协调：协调组件与坐标系之间的布局冲突解决
 * 4. 状态管理：维护布局过程中的状态信息和上下文
 *
 * 工作流程：
 * 1. collect() - 收集自动布局组件并分组
 * 2. executeCoordSysLayout() - 执行坐标系布局调整
 * 3. executeSeriesLayout() - 处理无坐标系系列的布局
 * 4. layoutComponents() - 计算并应用组件的最终布局
 * 5. reset() - 清理状态，为下次布局做准备
 *
 * 设计特点：
 * - 状态驱动：通过上下文对象管理布局状态
 * - 分阶段执行：将复杂布局逻辑分解为可控的阶段
 * - 错误容忍：对异常情况进行优雅处理，保证系统稳定性
 * - 性能优化：通过缓存和增量计算减少重复开销
 */
export class LegendAutoLayoutManager {
    /**
     * 已收集的组件分组信息。
     *
     * 按位置分组的组件集合，每个分组包含布局计算所需的所有信息。
     * 在 collect() 方法中填充，在 reset() 中清理。
     */
    private _groups: LayoutLegendGroups | null = null;

    /**
     * 有效的坐标系列表。
     *
     * 经过筛选的坐标系集合，只包含支持自动布局的坐标系实例。
     * 用于在布局计算中快速访问有效的坐标系。
     */
    private _validCoordSystems: LegendAvoidableCoordinateSystem[] | undefined;

    /**
     * 已设置布局上下文的系列视图列表。
     *
     * 记录所有被设置了 autoLayoutContext 的系列视图，用于清理操作。
     * 避免内存泄漏，保证每次布局计算的独立性。
     */
    private _seriesWithContext: LegendAvoidableSeriesView[] | undefined;

    /**
     * 收集并分组所有启用了自动布局的组件。
     *
     * 扫描全局模型中的所有图例和视觉映射组件，识别启用自动布局的组件，
     * 并按位置进行分组，为后续的布局计算做准备。
     *
     * 执行步骤：
     * 1. 查找所有图例和视觉映射组件
     * 2. 筛选启用自动布局的组件
     * 3. 按位置分组组件（top、bottom、left、right）
     * 4. 为每个组件执行尺寸估算
     * 5. 构建分组数据结构
     *
     * @param ecModel 全局模型，包含所有组件的配置和状态
     * @param api 扩展API，用于组件尺寸估算和环境访问
     * @returns 是否成功收集到自动布局组件；true 表示有组件需要布局，false 表示无组件或收集失败
     * @throws 如果组件配置有误可能抛出异常，但会被内部捕获并返回 false
     */
    public collect(ecModel: GlobalModel, api: ExtensionAPI): boolean {
        try {
            this._groups = collectLegendAutoLayoutGroups(ecModel, api) || null;
            return this._groups != null && Object.keys(this._groups).length > 0;
        }
        catch (e) {
            // 收集失败则清空，避免后续误用
            this._groups = null;
            return false;
        }
    }

    /**
     * 执行坐标系自动布局调整。
     *
     * 为每个位置的图例分组计算并应用坐标系的空间调整。
     * 通过与坐标系的协作，实现图例组件的智能避让和坐标系空间的合理压缩。
     *
     * 执行流程：
     * 1. 筛选有效的坐标系（具有边界矩形的坐标系）
     * 2. 为每个位置分组创建布局上下文
     * 3. 选择目标坐标系进行空间计算
     * 4. 计算其他坐标系的调整边距
     * 5. 应用布局调整到所有相关坐标系
     * 6. 记录调整后的边界矩形用于后续组件布局
     *
     * 布局策略：
     * - 单坐标系：直接应用布局调整
     * - 多坐标系：选择最相关的坐标系作为目标，其他坐标系根据距离进行调整
     *
     * @param coordSysList 可用的坐标系列表
     * @param ecModel 全局模型，用于访问组件状态
     * @param api 扩展API，用于坐标系布局应用
     */
    public executeCoordSysLayout(
        coordSysList: LegendAvoidableCoordinateSystem[],
        ecModel: GlobalModel,
        api: ExtensionAPI
    ): void {
        if (!coordSysList || coordSysList.length === 0) {
            return;
        }
        // 检查是否有有效的坐标系矩形
        const validCoordSystems: LegendAvoidableCoordinateSystem[] = [];
        coordSysList.forEach(cs => {
            if (cs && typeof cs.getOuterBoundingRect === 'function') {
                const rect = cs.getOuterBoundingRect();
                if (rect && rect.width > 0 && rect.height > 0) {
                    validCoordSystems.push(cs);
                }
            }
        });
        if (validCoordSystems.length === 0) {
            return;
        }
        this._validCoordSystems = validCoordSystems;
        const groups = this._groups;
        each(groups, (group, position) => {
            const context = this._prepareCoordSysContext(position);
            if (!context) {
                return;
            }

            let targetCoordSys: LegendAvoidableCoordinateSystem;
            // 选择目标坐标系
            if (validCoordSystems.length === 1) {
                targetCoordSys = validCoordSystems[0];
            }
            else {
                targetCoordSys = findLegendAutoLayoutCoordForPosition(position, validCoordSystems);
                if (!targetCoordSys) {
                    return;
                }
            }

            const targetRect = targetCoordSys.getOuterBoundingRect();
            // 调用目标坐标系的 applyAutoLayout 获取用于图例避让的矩形
            targetCoordSys.autoLayoutContext = context;
            targetCoordSys.applyAutoLayout?.(ecModel, api);
            // 为其他坐标系计算调整上下文并应用自动布局
            each(validCoordSystems, (coordSys) => {
                if (coordSys === targetCoordSys) {
                    return;
                }
                const adjustedContext = calculateLegendCompressForCoordSys(
                    context,
                    coordSys,
                    targetRect,
                    position
                );
                coordSys.autoLayoutContext = adjustedContext;
                coordSys.applyAutoLayout?.(ecModel, api);
            });

            // 将目标矩形记录到group，用于后续的finalizeLayout调用
            if (targetRect) {
                // 使用context.finalBoundingRect（如果存在，包含轴标签影响），否则使用targetRect
                const rectToUse = context.finalBoundingRect || targetRect;
                // 如果group已有targetRect（混合布局场景），需要合并
                if (group.targetRect) {
                    group.targetRect = mergeBoundingRects(group.targetRect, rectToUse);
                }
                else {
                    group.targetRect = rectToUse;
                }
            }
        });
    }

    /**
     * 为指定位置准备坐标系布局上下文。
     *
     * 创建包含分组信息和布局需求的上下文对象，用于传递给坐标系进行布局调整。
     * 上下文封装了该位置所有组件的分组信息和布局要求。
     *
     * @private
     * @param position 图例位置 ('top', 'bottom', 'left', 'right')
     * @returns 布局上下文对象；如果该位置无分组则返回 null
     */
    private _prepareCoordSysContext(
        position: string
    ): LayoutLegendContext | null {
        if (!this._groups) {
            return null;
        }
        const group = this._groups[position];
        if (!group) {
            return null;
        }
        return {
            group,
            needLayout: true
        };
    }

    /**
     * 执行系列自动布局调整。
     *
     * 处理无坐标系系列（如饼图、漏斗图等）的布局需求，为它们计算并应用空间调整。
     * 在混合布局场景中，确保系列与坐标系的布局协调一致。
     *
     * 执行流程：
     * 1. 获取所有系列并筛选有效的无坐标系系列
     * 2. 为每个位置分组找到对应的目标系列
     * 3. 计算目标系列的空间压缩需求
     * 4. 为其他相关系列计算调整边距
     * 5. 应用布局调整并记录边界矩形
     *
     * 特殊处理：
     * - 只处理无坐标系的系列，避免与坐标系布局冲突
     * - 通过系列视图的 getOuterBoundingRect 获取边界信息
     * - 支持系列间的相互避让和空间协调
     *
     * @param ecModel 全局模型，用于访问系列配置
     * @param api 扩展API，用于系列视图访问和环境信息
     */
    public executeSeriesLayout(ecModel: GlobalModel, api: ExtensionAPI): void {
        if (!this._groups) {
            return;
        }
        const seriesList = ecModel.getSeries();
        const container = getViewSize(api);
        if (!container) {
            return;
        }

        // 检查是否有有效的无坐标系系列矩形
        const validSeriesList: Array<{ series: SeriesModel; view: LegendAvoidableSeriesView; rect: BoundingRect }> = [];
        if (seriesList && seriesList.length > 0) {
            const _validCoordSystems = this._validCoordSystems;
            each(seriesList, (series) => {
                // 只处理无坐标系的系列
                const coordinateSystem = series.coordinateSystem;
                if (coordinateSystem && _validCoordSystems?.includes(coordinateSystem)) {
                    return;
                }
                const seriesView = api.getViewOfSeriesModel(series) as LegendAvoidableSeriesView;
                if (seriesView && typeof seriesView.getOuterBoundingRect === 'function') {
                    const rect = seriesView.getOuterBoundingRect(series, ecModel, api, null);
                    if (rect && rect.width > 0 && rect.height > 0) {
                        validSeriesList.push({ series, view: seriesView, rect });
                    }
                }
            });
        }

        if (validSeriesList.length === 0) {
            return;
        }
        // 为每个position的图例组件计算它对所有系列的影响
        each(this._groups, (group, position) => {
            // 根据position找到对应的目标系列
            const targetSeries = findLegendAutoLayoutSeriesForPosition(position, validSeriesList);
            if (!targetSeries) {
                return;
            }

            // 获取目标系列的视图
            const targetSeriesView = api.getViewOfSeriesModel(targetSeries) as LegendAvoidableSeriesView;
            if (!targetSeriesView) {
                return;
            }

            // 获取目标系列的外边界矩形
            const targetRect = targetSeriesView.getOuterBoundingRect(targetSeries, ecModel, api, null);
            if (!targetRect) {
                return;
            }
            // 计算目标系列在该方向上需要压缩的尺寸
            const targetContext = targetSeriesView.autoLayoutContext ?? (targetSeriesView.autoLayoutContext = {
                needLayout: false,
            });
            // 记录设置了context的系列
            if (!this._seriesWithContext) {
                this._seriesWithContext = [];
            }
            if (!this._seriesWithContext.includes(targetSeriesView)) {
                this._seriesWithContext.push(targetSeriesView);
            }

            fillLegendGroupSpaceToMargin(group, api, targetRect, null, targetContext);

            // 遍历其他系列，计算它们需要压缩的尺寸
            each(validSeriesList, (seriesInfo) => {
                const seriesView = seriesInfo.view;
                if (seriesView === targetSeriesView) {
                    return; // 跳过无效视图或目标系列
                }
                const adjustedContext = this._calculateAdjustedContextForSeries(
                    targetContext,
                    seriesInfo.series,
                    seriesView,
                    targetRect,
                    position,
                    api
                );
                seriesView.autoLayoutContext = adjustedContext;
                // 记录设置了context的系列
                if (adjustedContext && !this._seriesWithContext.includes(seriesView)) {
                    this._seriesWithContext.push(seriesView);
                }
            });

            graphic.expandOrShrinkRect(targetRect, targetContext.margin, true, true);
            // 将目标矩形记录到group，用于后续的finalizeLayout调用
            if (group.targetRect) {
                group.targetRect = mergeBoundingRects(group.targetRect, targetRect);
            }
            else {
                group.targetRect = targetRect;
            }
        });
    }

    /**
     * 执行组件的最终布局计算和应用。
     *
     * 在坐标系和系列布局调整完成后，计算每个组件的精确位置和尺寸，
     * 并将布局结果应用到组件模型上。这是布局流程的最后一步。
     *
     * 执行流程：
     * 1. 获取容器尺寸信息
     * 2. 遍历所有组件分组
     * 3. 根据分组的 targetRect 计算组件布局
     * 4. 处理无 targetRect 的分组（回退到画布布局）
     * 5. 调用分组布局函数应用最终位置
     *
     * 布局策略：
     * - 有 targetRect：基于调整后的坐标系边界进行布局
     * - 无 targetRect：回退到画布全区域布局（兜底策略）
     *
     * @param api 扩展API，用于获取容器尺寸和环境信息
     */
    public layoutComponents(api: ExtensionAPI): void {
        if (!this._groups) {
            return;
        }
        const container = getViewSize(api);
        if (!container) {
            return;
        }

        // 遍历所有groups，对每个group调用layoutGroup，如果没有targetRect则使用画布矩形
        each(this._groups, (group, position) => {
            let targetRect = group.targetRect;
            if (!targetRect) {
                // 回退到画布布局
                const canvasRect = new BoundingRect(0, 0, container.width, container.height);
                const context: LayoutLegendContext = { needLayout: false };
                fillLegendGroupSpaceToMargin(group, api, canvasRect, null, context);
                graphic.expandOrShrinkRect(canvasRect, context.margin, true, true);
                targetRect = canvasRect;
            }
            layoutLegendGroup(group, container, targetRect);
        });
    }

    /**
     * 重置管理器内部状态，为下次布局计算做准备。
     *
     * 清理所有在布局过程中设置的临时状态和上下文信息，
     * 确保每次布局计算的独立性和内存使用的最优化。
     *
     * 清理内容：
     * - 组件分组信息 (_groups)
     * - 有效坐标系列表 (_validCoordSystems)
     * - 系列视图的布局上下文 (autoLayoutContext)
     * - 上下文记录列表 (_seriesWithContext)
     *
     * 调用时机：
     * - 每次布局计算完成后
     * - 图表重新初始化时
     * - 组件配置发生重大变化时
     *
     * 注意：此方法不清理组件自身的布局参数，由组件自行管理。
     */
    public reset(): void {
        this._groups = null;
        this._validCoordSystems = null;
        // 清理所有设置了autoLayoutContext的系列
        if (this._seriesWithContext) {
            each(this._seriesWithContext, (seriesView) => {
                if (seriesView.autoLayoutContext) {
                    seriesView.autoLayoutContext = undefined;
                }
            });
            this._seriesWithContext = undefined;
        }
    }

    /**
     * 计算系列视图的布局调整上下文。
     *
     * 根据目标系列的布局调整需求，计算当前系列需要进行的布局调整。
     * 通过几何计算确定当前系列与目标系列的相对位置关系，计算所需的边距调整。
     *
     * 计算逻辑：
     * 1. 检查目标上下文是否有调整需求（margin 不全为 0）
     * 2. 获取当前系列的边界矩形
     * 3. 根据图例位置计算当前系列与目标系列的距离关系
     * 4. 计算需要的调整边距，确保不会与目标系列重叠
     * 5. 创建并返回调整上下文，或返回 undefined 表示无需调整
     *
     * 位置计算策略：
     * - bottom: 比较下边界距离，确保下方系列让出足够空间
     * - top: 比较上边界距离，确保上方系列让出足够空间
     * - left: 比较左边界距离，确保左侧系列让出足够空间
     * - right: 比较右边界距离，确保右侧系列让出足够空间
     *
     * @private
     * @param targetContext 目标系列的布局上下文，包含调整需求
     * @param series 当前待调整的系列模型
     * @param seriesView 当前系列的视图实例
     * @param targetRect 目标系列的边界矩形
     * @param position 图例位置，影响调整计算策略
     * @param api 扩展API，用于边界矩形计算
     * @returns 调整后的布局上下文；如果不需要调整则返回 undefined
     */
    private _calculateAdjustedContextForSeries(
        targetContext: LayoutLegendContext,
        series: SeriesModel,
        seriesView: LegendAvoidableSeriesView,
        targetRect: ZRRectLike,
        position: string,
        api: ExtensionAPI
    ): LayoutLegendContext | undefined {
        const targetMargin = targetContext.margin;
        // 如果目标上下文没有 margin，说明不需要调整
        if (!targetMargin || targetMargin.every(m => m === 0)) {
            return undefined;
        }

        const seriesRect = seriesView.getOuterBoundingRect(series, series.ecModel, api, null);
        if (!seriesRect) {
            return undefined;
        }

        let needsAdjustment = false;
        const adjustmentMargin = [0, 0, 0, 0];

        switch (position) {
            case 'bottom': {
                // 计算当前系列下边界到目标系列下边界的距离
                const seriesBottom = seriesRect.y + seriesRect.height;
                const targetBottom = targetRect.y + targetRect.height;
                const distance = seriesBottom - targetBottom;
                const requiredAdjustment = Math.max(0, targetMargin[2] + distance);
                if (requiredAdjustment > 0) {
                    adjustmentMargin[2] = requiredAdjustment;
                    needsAdjustment = true;
                }
                break;
            }
            case 'top': {
                // 计算目标系列上边界到当前系列上边界的距离
                const targetTop = targetRect.y;
                const seriesTop = seriesRect.y;
                const distance = seriesTop - targetTop;
                const requiredAdjustment = Math.max(0, targetMargin[0] - distance);
                if (requiredAdjustment > 0) {
                    adjustmentMargin[0] = requiredAdjustment;
                    needsAdjustment = true;
                }
                break;
            }
            case 'left': {
                // 计算目标系列左边界到当前系列左边界的距离
                const targetLeft = targetRect.x;
                const seriesLeft = seriesRect.x;
                const distance = seriesLeft - targetLeft;
                const requiredAdjustment = Math.max(0, targetMargin[3] - distance);
                if (requiredAdjustment > 0) {
                    adjustmentMargin[3] = requiredAdjustment;
                    needsAdjustment = true;
                }
                break;
            }
            case 'right': {
                // 计算当前系列右边界到目标系列右边界的距离
                const seriesRight = seriesRect.x + seriesRect.width;
                const targetRight = targetRect.x + targetRect.width;
                const distance = seriesRight - targetRight;
                const requiredAdjustment = Math.max(0, targetMargin[1] + distance);
                if (requiredAdjustment > 0) {
                    adjustmentMargin[1] = requiredAdjustment;
                    needsAdjustment = true;
                }
                break;
            }
        }

        // 只有当需要调整时才创建/更新context
        if (needsAdjustment) {
            // 获取或创建系列的context
            let seriesContext = seriesView.autoLayoutContext;
            if (!seriesContext) {
                seriesContext = {
                    needLayout: false,
                    margin: [0, 0, 0, 0]
                };
                seriesView.autoLayoutContext = seriesContext;
            }

            // 确保margin数组存在
            if (!seriesContext.margin) {
                seriesContext.margin = [0, 0, 0, 0];
            }

            // 累加调整的margin
            for (let i = 0; i < 4; i++) {
                seriesContext.margin[i] = Math.max(seriesContext.margin[i], adjustmentMargin[i]);
            }

            return seriesContext;
        }

        return undefined;
    }
}

/**
 * 类型守卫函数：检查图表视图是否实现了 SymbolRectProvider 接口。
 *
 * 用于在运行时安全地检查视图对象是否提供了符号边界矩形查询能力。这是 TypeScript
 * 类型守卫的高级用法，确保类型安全的同时提供运行时检查。
 *
 * 使用场景：
 * - 在需要精确符号边界计算的逻辑中进行能力检查
 * - 为不同视图提供差异化的符号处理策略
 * - 确保代码的向后兼容性和扩展性
 *
 * @param view 待检查的图表视图实例，可能为 null 或 undefined
 * @returns 类型谓词，如果视图实现了 SymbolRectProvider 接口则返回 true，同时
 * TypeScript 编译器会将 view 类型缩小为 ChartView & SymbolRectProvider
 */
export function isSymbolRectProvider(view: ChartView | null | undefined): view is ChartView & SymbolRectProvider {
    return view != null && typeof (view as any).getSymbolRect === 'function';
}

/**
 * 根据图例位置选择最适合的自动布局坐标系统。
 *
 * 从给定的坐标系统列表中选择一个最适合处理指定位置图例布局的坐标系统。
 * 选择策略基于坐标系统的边界矩形位置，选择最靠近目标位置的坐标系统。
 *
 * 选择逻辑：
 * - bottom: 选择下边界位置最低（y + height 最大）的坐标系统
 * - top: 选择上边界位置最高（y 最小）的坐标系统
 * - left: 选择左边界位置最左（x 最小）的坐标系统
 * - right: 选择右边界位置最右（x + width 最大）的坐标系统
 *
 * 设计意图：
 * - 确保图例布局时选择最相关的坐标系统进行空间调整
 * - 支持多坐标系场景下的智能选择
 * - 避免不必要的坐标系调整，提高性能
 *
 * @param position 图例布局位置，影响坐标系选择策略
 * @param coordinateSystems 可用的自动布局坐标系统列表
 * @returns 最适合的坐标系统实例；如果列表为空或无有效坐标系统则返回 null
 */
export function findLegendAutoLayoutCoordForPosition(
    position: string,
    coordinateSystems: LegendAvoidableCoordinateSystem[]
): LegendAvoidableCoordinateSystem | null {
    if (!coordinateSystems || coordinateSystems.length === 0) {
        return null;
    }
    switch (position) {
        case 'bottom': {
            // 找到 y + height 最大的自动布局坐标系统（最下面的）
            return coordinateSystems.reduce((bottomGrid, current) => {
                const currentRect = current.getOuterBoundingRect();
                const bottomRect = bottomGrid ? bottomGrid.getOuterBoundingRect() : currentRect;
                return (currentRect.y + currentRect.height) > (bottomRect.y + bottomRect.height)
                    ? current : bottomGrid;
            });
        }
        case 'top': {
            // 找到 y 最小的自动布局坐标系统（最上面的）
            return coordinateSystems.reduce((topGrid, current) => {
                const currentRect = current.getOuterBoundingRect();
                const topRect = topGrid ? topGrid.getOuterBoundingRect() : currentRect;
                return currentRect.y < topRect.y ? current : topGrid;
            });
        }
        case 'left': {
            // 找到 x 最小的自动布局坐标系统（最左边的）
            return coordinateSystems.reduce((leftGrid, current) => {
                const currentRect = current.getOuterBoundingRect();
                const leftRect = leftGrid ? leftGrid.getOuterBoundingRect() : currentRect;
                return currentRect.x < leftRect.x ? current : leftGrid;
            });
        }
        case 'right': {
            // 找到 x + width 最大的自动布局坐标系统（最右边的）
            return coordinateSystems.reduce((rightGrid, current) => {
                const currentRect = current.getOuterBoundingRect();
                const rightRect = rightGrid ? rightGrid.getOuterBoundingRect() : currentRect;
                return (currentRect.x + currentRect.width) > (rightRect.x + rightRect.width)
                    ? current : rightGrid;
            });
        }
        default: {
            return coordinateSystems[0]; // 默认使用第一个自动布局坐标系统
        }
    }
}

/**
 * 根据图例位置选择最适合的无坐标系系列。
 *
 * 从有效的无坐标系系列列表中选择一个最适合处理指定位置图例布局的系列。
 * 选择策略基于系列的边界矩形位置，选择最靠近目标位置的系列。
 *
 * 选择逻辑：
 * - bottom: 选择下边界位置最低（y + height 最大）的系列
 * - top: 选择上边界位置最高（y 最小）的系列
 * - left: 选择左边界位置最左（x 最小）的系列
 * - right: 选择右边界位置最右（x + width 最大）的系列
 *
 * 设计意图：
 * - 为无坐标系系列（如饼图、漏斗图）提供布局避让能力
 * - 确保图例布局时选择最相关的系列进行空间协调
 * - 支持混合布局场景下的智能选择
 *
 * 注意：此函数专门处理无坐标系的系列，与坐标系布局逻辑分离。
 *
 * @param position 图例布局位置，影响系列选择策略
 * @param validSeriesList 有效的无坐标系系列列表，包含系列模型、视图和边界矩形
 * @returns 最适合的系列模型实例；如果列表为空则返回 null
 */
export function findLegendAutoLayoutSeriesForPosition(
    position: string,
    validSeriesList: Array<{ series: SeriesModel; view: LegendAvoidableSeriesView; rect: BoundingRect }>
): SeriesModel | null {

    let bestSeries: SeriesModel | null = null;
    let bestRect: BoundingRect | null = null;

    // 遍历有效的无坐标系系列列表
    validSeriesList.forEach(({ series, rect }) => {
        // 如果这是第一个有效系列，直接选中
        if (bestSeries == null) {
            bestSeries = series;
            bestRect = rect;
            return;
        }
        switch (position) {
            case 'bottom': {
                // 找到 y + height 最大的系列（最下面的）
                if ((rect.y + rect.height) > (bestRect.y + bestRect.height)) {
                    bestSeries = series;
                    bestRect = rect;
                }
                break;
            }
            case 'top': {
                // 找到 y 最小的系列（最上面的）
                if (rect.y < bestRect.y) {
                    bestSeries = series;
                    bestRect = rect;
                }
                break;
            }
            case 'left': {
                // 找到 x 最小的系列（最左边的）
                if (rect.x < bestRect.x) {
                    bestSeries = series;
                    bestRect = rect;
                }
                break;
            }
            case 'right': {
                // 找到 x + width 最大的系列（最右边的）
                if ((rect.x + rect.width) > (bestRect.x + bestRect.width)) {
                    bestSeries = series;
                    bestRect = rect;
                }
                break;
            }
        }
    });

    return bestSeries;
}

/**
 * 预处理自动布局配置选项，设置智能默认值。
 *
 * 根据用户的自动布局配置进行预处理，确保配置的完整性和一致性。
 * 主要处理布局方向的自动推断，避免用户需要手动设置冗余的配置项。
 *
 * 处理逻辑：
 * 1. 检查自动布局是否启用
 * 2. 根据位置自动设置布局方向（orient）
 *   - top/bottom 位置：设置 orient 为 'horizontal'
 *   - left/right 位置：设置 orient 为 'vertical'
 * 3. 保持其他配置项不变
 *
 * 设计意图：
 * - 简化用户配置，减少认知负担
 * - 确保配置的向后兼容性
 * - 提供智能的默认行为
 *
 * 调用时机：
 * - 组件配置初始化时
 * - 配置更新后需要重新计算时
 *
 * @param option 图例或视觉映射组件的配置选项，会被原地修改
 */
export function preprocessLegendAutoLayoutOption(option: LegendOption | VisualMapOption): void {
    const autoLayout = option.autoLayout;
    if (!autoLayout || !autoLayout.enable) {
        return;
    }
    const position = autoLayout.position;
    // 根据自动布局位置设置布局方向
    if (position === 'top' || position === 'bottom') {
        option.orient = 'horizontal';
    }
    else {
        option.orient = 'vertical';
    }
}

/**
 * 收集所有启用了自动布局的组件并按位置进行分组。
 *
 * 扫描全局模型中的所有图例和视觉映射组件，识别启用了自动布局的组件，
 * 并根据其位置配置进行分组，为后续的布局计算准备数据结构。
 *
 * 执行流程：
 * 1. 查找所有图例和视觉映射组件
 * 2. 筛选启用自动布局的组件
 * 3. 提取组件的布局配置参数
 * 4. 为每个组件执行尺寸估算
 * 5. 按位置创建或更新分组
 * 6. 将组件添加到对应分组中
 *
 * 分组策略：
 * - 按位置分组：'top'、'bottom'、'left'、'right'
 * - 每个分组包含布局参数和组件列表
 * - 支持图例和视觉映射的混合分组
 *
 * 返回结果：
 * - 包含分组信息的对象，每个位置对应一个分组
 * - 如果没有找到任何自动布局组件，返回空对象
 *
 * 设计意图：
 * - 提供布局计算的数据基础
 * - 支持多组件协同布局
 * - 隔离不同位置的布局逻辑
 *
 * @param ecModel 全局模型，包含所有组件的配置和状态
 * @param api 扩展API，用于组件尺寸估算
 * @returns 按位置分组的组件集合；如果无自动布局组件则返回空对象
 */
export function collectLegendAutoLayoutGroups(
    ecModel: GlobalModel,
    api: ExtensionAPI
): LayoutLegendGroups {
    let groups: LayoutLegendGroups;
    // 收集所有启用 autoLayout 的组件
    const legends = ecModel.findComponents({ mainType: 'legend' }) as AutoLayoutComponentModel[];
    const vms = ecModel.findComponents({ mainType: 'visualMap' }) as AutoLayoutComponentModel[];

    const collectComponents = (components: Array<AutoLayoutComponentModel>) => {
        components.forEach(model => {
            const autoLayout = model?.get('autoLayout');
            if (autoLayout?.enable !== true) {
                return;
            }
            if (!groups) {
                groups = {};
            }
            const position = autoLayout.position;
            const align = autoLayout.align || 'center';
            const layoutMode = autoLayout.layoutMode || 'multiLine';
            const margin = autoLayout.margin ?? DEFAULT_LEGEND_LAYOUT_CONFIG.margin;
            const itemGap = autoLayout.itemGap ?? DEFAULT_LEGEND_LAYOUT_CONFIG.itemGap;
            const isScroll = model.subType === 'scroll';
            // 获取估算尺寸
            const estimatedSize = estimateLegendSize(model, api, ecModel);
            // 创建或获取分组
            const groupId = position;
            let group = groups[groupId];
            if (!group) {
                group = groups[groupId] = createLegendLayoutGroup(
                    groupId, position, align, layoutMode, margin, itemGap
                );
            }
            // 添加组件到分组
            group.items.push({
                model,
                scroll: !!isScroll,
                estimatedSize,
            });
        });
    };

    collectComponents(legends);
    collectComponents(vms);
    return groups;
}

/**
 * 计算图例分组的空间需求并转换为坐标系的边距调整。
 *
 * 分析指定图例分组在当前坐标系空间下的布局需求，计算需要的额外空间，
 * 并将空间需求转换为坐标系的边距调整值，用于后续的坐标系压缩。
 *
 * 计算逻辑：
 * 1. 计算分组在指定位置需要的空间大小
 * 2. 获取当前位置的可用空间
 * 3. 计算空间缺口（neededSpace - availableSpace）
 * 4. 将空间缺口转换为对应方向的边距值
 *
 * 边距映射：
 * - top: margin[0]
 * - right: margin[1]
 * - bottom: margin[2]
 * - left: margin[3]
 *
 * 设计意图：
 * - 将组件的空间需求转换为坐标系的几何调整
 * - 支持渐进式的空间分配策略
 * - 确保图例组件有足够的显示空间
 *
 * @param group 待计算的图例分组，包含组件列表和布局参数
 * @param api 扩展API，用于获取容器尺寸信息
 * @param gridRect 当前坐标系的边界矩形
 * @param margin 现有的边距数组，用于累积空间调整
 * @param context 布局上下文，用于存储计算结果
 * @returns 是否产生了空间调整需求；true 表示需要额外的空间，false 表示空间充足
 */
export function fillLegendGroupSpaceToMargin(
    group: LayoutLegendGroup,
    api: ExtensionAPI,
    gridRect: ZRRectLike,
    margin: number[],
    context: LayoutLegendContext
): boolean {
    try {
        // 计算分组需要的空间
        const spaceRequirement = calculateLegendGroupSpace(group, api, gridRect, margin);
        // 如果需要的空间超过可用空间，累积到 margin
        if (spaceRequirement.neededSpace > spaceRequirement.availableSpace) {
            const extraSpace = spaceRequirement.neededSpace - spaceRequirement.availableSpace;
            const positionToMarginIndex = {
                top: 0,
                bottom: 2,
                left: 3,
                right: 1
            };
            const margin = context.margin ?? (context.margin = [0, 0, 0, 0]);
            margin[positionToMarginIndex[group.position]] += extraSpace;
            return true; // 需要空间
        }
        return false; // 不需要空间
    }
    catch (error) {
        console.error('Fill legend group space to margin failed', error);
        return false;
    }
}

/**
 * 计算图例分组的空间需求信息。
 *
 * 分析指定图例分组在当前布局条件下的空间需求，包括：
 * - 该分组需要的总空间大小
 * - 当前可用空间大小
 * - 空间充足性判断
 *
 * 空间计算考虑因素：
 * - 组件的估算尺寸
 * - 组件间的间距
 * - 组件与坐标系的边距
 * - 布局模式（单行/多行）
 * - 现有边距调整
 *
 * @private
 * @param group 待计算的图例分组
 * @param api 扩展API，用于获取容器尺寸
 * @param gridRect 当前坐标系的边界矩形
 * @param margin 现有的边距调整数组
 * @returns 包含 neededSpace（需要空间）和 availableSpace（可用空间）的对象
 */
function calculateLegendGroupSpace(
    group: LayoutLegendGroup,
    api: ExtensionAPI,
    gridRect: ZRRectLike,
    margin: number[]
): { neededSpace: number; availableSpace: number } {
    const { position, items } = group;

    const positionToMarginIndex = {
        top: 0,
        bottom: 2,
        left: 3,
        right: 1
    };

    // 计算该方向的可用空间
    let availableSpace: number;
    if (position === 'top') {
        availableSpace = gridRect.y;
    }
    else if (position === 'bottom') {
        availableSpace = api.getHeight() - (gridRect.y + gridRect.height);
    }
    else if (position === 'left') {
        availableSpace = gridRect.x;
    }
    else {
        // position === 'right'
        availableSpace = api.getWidth() - (gridRect.x + gridRect.width);
    }

    const existMarginValue = margin?.[positionToMarginIndex[position]];
    if (existMarginValue > 0) {
        availableSpace += existMarginValue;
    }
    if (items.length === 0) {
        return { neededSpace: 0, availableSpace };
    }
    if (items.length === 1) {
        // 单个组件，直接使用其估算大小
        const size = items[0].estimatedSize;
        if (!size) {
            return { neededSpace: 0, availableSpace };
        }
        const mainSize = (position === 'top' || position === 'bottom') ? size.height : size.width;
        return { neededSpace: mainSize + group.margin, availableSpace };
    }
    // 多个组件，需要考虑排列方式
    return calculateMultiLegendSpace(group, availableSpace);
}

/**
 * 计算多个图例的空间需求。
 *
 * @param group 分组对象。
 * @param availableSpace 可用空间。
 * @returns 空间需求信息。
 */
function calculateMultiLegendSpace(
    group: LayoutLegendGroup,
    availableSpace: number
): { neededSpace: number; availableSpace: number } {
    const { position, items, layoutMode } = group;

    const isHorizontal = position === 'top' || position === 'bottom';
    if (items.length === 1) {
        // 单个组件，直接使用其估算大小
        const size = items[0].estimatedSize;
        if (!size || size.width <= 0 || size.height <= 0) {
            return { neededSpace: 0, availableSpace };
        }
        const mainSize = isHorizontal ? size.height : size.width;
        return { neededSpace: mainSize + group.margin, availableSpace };
    }

    if (layoutMode === 'singleLine') {
        // 单行布局：所有组件在一行/列
        if (isHorizontal) {
            // 水平位置：单行布局
            const heights = items.map(item => {
                const size = item.estimatedSize;
                return size && size.height > 0 ? size.height : 0;
            });
            return { neededSpace: Math.max(...heights) + group.margin, availableSpace };
        }
        else {
            // 垂直位置：单列布局
            const widths = items.map(item => {
                const size = item.estimatedSize;
                return size && size.width > 0 ? size.width : 0;
            });
            return { neededSpace: Math.max(...widths) + group.margin, availableSpace };
        }
    }
    else {
        // 多行布局：每个组件单独一行/列
        if (isHorizontal) {
            // 水平位置：每个组件单独一行
            const totalHeight = items.reduce((sum, item) => {
                const size = item.estimatedSize;
                const height = size && size.height > 0 ? size.height : 0;
                return sum + height;
            }, 0) + group.itemGap * (items.length - 1);
            return { neededSpace: totalHeight + group.margin, availableSpace };
        }
        else {
            // 垂直位置：每个组件单独一列
            const totalWidth = items.reduce((sum, item) => {
                const size = item.estimatedSize;
                const width = size && size.width > 0 ? size.width : 0;
                return sum + width;
            }, 0) + group.itemGap * (items.length - 1);
            return { neededSpace: totalWidth + group.margin, availableSpace };
        }
    }
}

/**
 * 执行图例分组的自动布局计算和应用。
 *
 * 根据分组的布局配置和容器空间，计算每个组件的精确位置和尺寸，并将布局结果应用
 * 到组件模型上。这是自动布局系统的核心布局函数。
 *
 * 布局策略：
 * 1. 单组件布局：直接定位到指定位置
 * 2. 多组件布局：
 *    - singleLine 模式：所有组件在一行/列显示
 *    - multiLine 模式：每个组件单独一行/列
 *
 * 支持的布局方向：
 * - horizontal（水平布局）：适用于 top/bottom 位置
 * - vertical（垂直布局）：适用于 left/right 位置
 *
 * 错误处理：
 * - 布局计算失败时会回退到默认位置（左上角）
 * - 通过 console.error 输出错误信息便于调试
 *
 * 设计意图：
 * - 提供统一的布局接口，支持多种布局模式
 * - 确保布局结果的稳定性和可预测性
 * - 支持复杂的多组件协同布局场景
 *
 * @param group 包含布局参数和组件列表的分组对象
 * @param container 容器尺寸信息，包含宽度和高度
 * @param gridRect 坐标系的边界矩形，用于确定布局基准位置
 */
export function layoutLegendGroup(
    group: LayoutLegendGroup,
    container: { width: number; height: number },
    gridRect: ZRRectLike
) {
    try {
        const items = group.items;

        if (items.length === 0) {
            return;
        }

        if (items.length === 1) {
            // 单个组件：直接布局
            layoutSingleLegend(group, container, gridRect);
        }
        else {
            if (group.layoutMode === 'singleLine') {
                // 单行布局：所有组件在一行/列
                if (group.orient === 'horizontal') {
                    layoutLegendHorizontalSingleRow(group, container, gridRect);
                }
                else {
                    layoutLegendVerticalSingleColumn(group, container, gridRect);
                }
            }
            else {
                // 多行布局：每个组件单独一行/列
                if (group.orient === 'horizontal') {
                    layoutLegendHorizontalRows(group, container, gridRect);
                }
                else {
                    layoutLegendVerticalColumns(group, container, gridRect);
                }
            }
        }
    }
    catch (error) {
        console.error(`Auto layout failed for group ${group.id}`, error);
        // 回退到默认布局：将组件放在左上角
        group.items.forEach(item => {
            try {
                item.model.setAutoLayoutBoxParams({
                    left: 0,
                    top: 0,
                    width: item.estimatedSize.width,
                    height: item.estimatedSize.height
                });
            }
            catch (modelError) {
                console.error('Failed to set layout for component', modelError);
            }
        });
    }
}

/**
 * 执行单个图例组件的布局计算。
 *
 * 为分组中的单个组件计算精确的布局位置，根据组件的位置配置和对齐方式，计算出
 * left/top/right/bottom 的具体像素值。
 *
 * 布局逻辑：
 * - 根据位置（top/bottom/left/right）确定基准坐标
 * - 使用对齐方式（start/center/end）计算偏移量
 * - 考虑分组边距对最终位置的影响
 * - 直接设置组件的自动布局参数
 *
 * 位置计算规则：
 * - top: 设置 bottom 值，从容器底部向上计算
 * - bottom: 设置 top 值，从坐标系底部向下计算
 * - left: 设置 right 值，从容器右侧向左计算
 * - right: 设置 left 值，从坐标系右侧向右计算
 *
 * @private
 * @param group 包含单个组件的分组对象
 * @param container 容器尺寸信息
 * @param gridRect 坐标系边界矩形
 */
function layoutSingleLegend(
    group: LayoutLegendGroup,
    container: { width: number; height: number },
    gridRect: ZRRectLike
): void {
    try {
        const { position, items, align } = group;
        const item = items[0];
        const itemSize = item.estimatedSize || {
            width: 0,
            height: 0
        };
        let newBox: BoxLayoutOptionMixin;
        switch (position) {
            case 'top': {
                newBox = {
                    bottom: container.height - gridRect.y + group.margin,
                    ...calculateHorizontalAlign(align, container.width, itemSize.width)
                };
                break;
            }
            case 'bottom': {
                newBox = {
                    top: gridRect.y + gridRect.height + group.margin,
                    ...calculateHorizontalAlign(align, container.width, itemSize.width)
                };
                break;
            }
            case 'left': {
                newBox = {
                    right: container.width - gridRect.x + group.margin,
                    ...calculateVerticalAlign(align, container.height, itemSize.height)
                };
                break;
            }
            case 'right': {
                newBox = {
                    left: gridRect.x + gridRect.width + group.margin,
                    ...calculateVerticalAlign(align, container.height, itemSize.height)
                };
                break;
            }
            default: {
                break;
            }
        }
        item.model.setAutoLayoutBoxParams(newBox);
    }
    catch (error) {
        console.error(`Layout single item failed for group ${group.id}`, error);
        // 回退到默认布局
        const item = group.items[0];
        item.model.setAutoLayoutBoxParams(undefined);
    }
}

/**
 * 水平位置多行布局（每个图例一行）。
 *
 * @param group 分组对象。
 * @param container 容器尺寸。
 * @param gridRect 网格矩形。
 */
function layoutLegendHorizontalRows(
    group: LayoutLegendGroup,
    container: { width: number; height: number },
    gridRect: ZRRectLike
) {
    const { position, items, align } = group;
    const itemGap = group.itemGap;

    if (position === 'bottom') {
        // bottom位置：从grid底部开始向下布局
        let top = gridRect.y + gridRect.height + group.margin;
        items.forEach(item => {
            const itemSize = item.estimatedSize || {
                width: 0,
                height: 0
            };
            // 计算X对齐偏移
            const alignProps = calculateHorizontalAlign(align, container.width, itemSize.width);
            const newBox: BoxLayoutOptionMixin = {
                ...alignProps,
                top: top,
            };
            item.model.setAutoLayoutBoxParams(newBox);
            top += itemSize.height + itemGap;
        });
    }
    else {
        // top位置：从grid顶部开始向上布局
        let bottom = container.height - gridRect.y + group.margin;
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const itemSize = item.estimatedSize || {
                width: 0,
                height: 0
            };
            // 计算X对齐偏移
            const alignProps = calculateHorizontalAlign(align, container.width, itemSize.width);
            const newBox: BoxLayoutOptionMixin = {
                ...alignProps,
                bottom: bottom,
            };
            item.model.setAutoLayoutBoxParams(newBox);
            bottom += itemSize.height + itemGap;
        }
    }
}


/**
 * 创建默认的图例布局分组。
 */
export function createLegendLayoutGroup(
    id: string,
    position: 'bottom' | 'top' | 'left' | 'right',
    align: LegendLayoutAlign = 'center',
    layoutMode: 'singleLine' | 'multiLine' = 'multiLine',
    margin: number = DEFAULT_LEGEND_LAYOUT_CONFIG.margin,
    itemGap: number = DEFAULT_LEGEND_LAYOUT_CONFIG.itemGap
): LayoutLegendGroup {
    const orient: LegendLayoutOrient = (position === 'top' || position === 'bottom') ? 'horizontal' : 'vertical';

    return {
        id,
        position,
        orient,
        align,
        layoutMode,
        margin,
        itemGap,
        items: []
    };
}

/**
 * 应用尺寸约束到估算尺寸。
 *
 * @param model 组件模型
 * @param estimatedSize 原始估算尺寸
 * @returns 应用约束后的尺寸
 */
function applySizeConstraints(
    model: AutoLayoutComponentModel,
    estimatedSize: { width: number; height: number }
): { width: number; height: number } {
    const constrainedSize = { ...estimatedSize };
    const minSize = model.get('minSize');
    const maxSize = model.get('maxSize');

    // 应用最小尺寸约束
    if (minSize) {
        if (minSize.width != null) {
            constrainedSize.width = Math.max(constrainedSize.width, minSize.width);
        }
        if (minSize.height != null) {
            constrainedSize.height = Math.max(constrainedSize.height, minSize.height);
        }
    }

    // 应用最大尺寸约束
    if (maxSize) {
        if (maxSize.width != null) {
            constrainedSize.width = Math.min(constrainedSize.width, maxSize.width);
        }
        if (maxSize.height != null) {
            constrainedSize.height = Math.min(constrainedSize.height, maxSize.height);
        }
    }

    return constrainedSize;
}

// 计算容器尺寸。
function getViewSize(api: ExtensionAPI) {
    return { width: api.getWidth(), height: api.getHeight() };
}

/**
 * 计算水平对齐的BoxLayoutOptionMixin属性。
 *
 * @param align 对齐方式：'start' | 'center' | 'end'
 * @param containerWidth 容器宽度
 * @param itemWidth 项目宽度
 * @returns 包含left或right属性的对象
 */
function calculateHorizontalAlign(
    align: LegendLayoutAlign,
    containerWidth: number,
    itemWidth: number
): { left?: number; right?: number } {
    switch (align) {
        case 'start': {
            return { left: 0 };
        }
        case 'center': {
            return { left: Math.floor((containerWidth - itemWidth) / 2) };
        }
        case 'end': {
            return { right: 0 };
        }
        default: {
            return { left: 0 };
        }
    }
}

/**
 * 计算垂直对齐的BoxLayoutOptionMixin属性。
 *
 * @param align 对齐方式：'start' | 'center' | 'end'
 * @param containerHeight 容器高度
 * @param itemHeight 项目高度
 * @returns 包含top或bottom属性的对象
 */
function calculateVerticalAlign(
    align: LegendLayoutAlign,
    containerHeight: number,
    itemHeight: number
): { top?: number; bottom?: number } {
    switch (align) {
        case 'start': {
            return { top: 0 };
        }
        case 'center': {
            return { top: Math.floor((containerHeight - itemHeight) / 2) };
        }
        case 'end': {
            return { bottom: 0 };
        }
        default: {
            return { top: 0 };
        }
    }
}

/**
 * 计算组件在指定维度上的 padding 总和。
 *
 * @param model 组件模型
 * @param dimension 维度：'width' | 'height'
 * @returns padding 总和
 */
function getPaddingSum(model: AutoLayoutComponentModel, dimension: 'width' | 'height'): number {
    const visualMapModel = model as VisualMapModel;
    const padding = visualMapModel.get('padding');
    if (padding) {
        const normalizedPadding = zrUtil.normalizeCssArray(padding as number | number[]);
        // 对于宽度，考虑左右 padding；对于高度，考虑上下 padding
        return dimension === 'width'
            ? normalizedPadding[1] + normalizedPadding[3]  // left + right
            : normalizedPadding[0] + normalizedPadding[2]; // top + bottom
    }
    return 0;
}

/**
 * 计算图例组件尺寸压缩。
 *
 * 按组件尺寸从大到小排序，依次压缩到最小尺寸，剩余压缩平均分配。
 *
 * @param items 组件项数组
 * @param totalSize 总尺寸
 * @param containerSize 容器尺寸
 * @param dimension 压缩维度，'width' 或 'height'
 * @returns 压缩映射，未压缩则返回undefined
 */
function calculateLegendCompress(
    items: LayoutLegendGroupItem[],
    totalSize: number,
    containerSize: number,
    dimension: 'width' | 'height'
): Record<number, number> | undefined {
    if (totalSize <= containerSize) {
        return undefined; // 不需要压缩
    }

    // 增加1px的间距作为安全边际
    const totalCompressSize = totalSize - containerSize + 1;
    const compressMap: Record<number, number> = {};

    // 按组件尺寸从大到小排序
    const sortedIndices: number[] = items.map((item, index) => index);
    sortedIndices.sort((a, b) => items[b].estimatedSize[dimension] - items[a].estimatedSize[dimension]);

    let remainingCompress = totalCompressSize;
    const defaultMinSize = containerSize / items.length;
    // 第一遍：从大到小依次压缩，每个组件最多压缩到最小允许尺寸
    for (let i = 0; i < sortedIndices.length; i++) {
        if (remainingCompress <= 0) {
            break;
        }
        const index = sortedIndices[i];
        const item = items[index];
        const size = item.estimatedSize[dimension];
        const minSize = Math.max(
            item.model.get('minSize')?.[dimension] || 0,
            defaultMinSize
        );

        const maxCompress = Math.max(0, size - minSize);
        const actualCompress = Math.min(maxCompress, remainingCompress);

        if (actualCompress > 0) {
            compressMap[index] = actualCompress;
        }
        remainingCompress -= actualCompress;
    }

    // 第二遍：如果还有剩余压缩需求，平均分配给所有组件
    if (remainingCompress > 0) {
        const compressibleCount = sortedIndices.length;
        const avgRemainingCompress = remainingCompress / compressibleCount;
        for (let i = 0; i < sortedIndices.length; i++) {
            const index = sortedIndices[i];
            compressMap[index] = (compressMap[index] || 0) + avgRemainingCompress;
        }
    }

    return compressMap;
}

/**
 * 水平位置图例单行布局。
 *
 * @param group 分组对象。
 * @param container 容器尺寸。
 * @param gridRect 网格矩形。
 */
function layoutLegendHorizontalSingleRow(
    group: LayoutLegendGroup,
    container: { width: number; height: number },
    gridRect: ZRRectLike
) {
    const { position, items, align } = group;
    const itemGap = group.itemGap;

    const gapWidth = (items.length - 1) * itemGap;
    // 计算总宽度
    const totalWidth = items.reduce((sum, item) => {
        const size = item.estimatedSize;
        const width = size && size.width > 0 ? size.width : 0;
        return sum + width;
    }, 0) + gapWidth;
    let effectiveTotalWidth = totalWidth;
    const containerWidth = container.width;
    // 计算需要压缩的组件宽度
    const compressMap = calculateLegendCompress(items, totalWidth, containerWidth, 'width');
    if (compressMap) {
        effectiveTotalWidth = container.width;
    }

    // 计算起始X位置或right值
    let left: number;
    let right: number;
    switch (align) {
        case 'start': {
            left = 0;
            break;
        }
        case 'center': {
            left = Math.floor((container.width - effectiveTotalWidth) / 2);
            break;
        }
        case 'end': {
            // end对齐：从右边开始，使用right属性
            right = 0;
            break;
        }
        default: {
            left = 0;
            break;
        }
    }

    // 计算Y位置
    const layoutBox: BoxLayoutOptionMixin = position === 'bottom'
        ? { top: gridRect.y + gridRect.height + group.margin }
        : { bottom: container.height - gridRect.y + group.margin };

    // 布局组件
    if (right != null) {
        // end对齐：从右往左布局
        for (let i = items.length - 1; i >= 0; i--) {
            const itemSize = items[i].estimatedSize || {
                width: 0,
                height: 0
            };
            const compressWidth = compressMap?.[i];
            const layoutParams: BoxLayoutOptionMixin = { right: right, ...layoutBox };
            let itemWidth = itemSize.width;
            if (compressWidth != null) {
                const paddingSum = getPaddingSum(items[i].model, 'width');
                itemWidth = itemWidth - compressWidth;
                // 布局参数的宽度是不包含padding的，所以在设置布局参数时需要减去padding。
                layoutParams.width = itemWidth - paddingSum;
            }
            else {
                layoutParams.width = itemWidth;
            }
            items[i].model.setAutoLayoutBoxParams(layoutParams);
            right += itemWidth + itemGap;
        }
    }
    else {
        // start或center对齐：从左往右布局
        items.forEach((item, index) => {
            const itemSize = item.estimatedSize || {
                width: 0,
                height: 0
            };
            let itemWidth = itemSize.width;
            const compressWidth = compressMap?.[index];
            const layoutParams: BoxLayoutOptionMixin = { left: left, ...layoutBox };
            if (compressWidth != null) {
                const paddingSum = getPaddingSum(item.model, 'width');
                itemWidth = itemWidth - compressWidth;
                // 布局参数的宽度是不包含padding的，所以在设置布局参数时需要减去padding。
                layoutParams.width = itemWidth - paddingSum;
            }
            else {
                layoutParams.width = itemWidth;
            }
            item.model.setAutoLayoutBoxParams(layoutParams);
            left += itemWidth + itemGap;
        });
    }
}

/**
 * 垂直位置图例单列布局。
 */
function layoutLegendVerticalSingleColumn(
    group: LayoutLegendGroup,
    container: { width: number; height: number },
    gridRect: ZRRectLike
) {
    const { position, items, align } = group;
    const itemGap = group.itemGap;

    const gapHeight = (items.length - 1) * itemGap;
    // 计算总高度
    const totalHeight = items.reduce((sum, item) => {
        const size = item.estimatedSize;
        const height = size && size.height > 0 ? size.height : 0;
        return sum + height;
    }, 0) + gapHeight;
    let effectiveTotalHeight = totalHeight;
    const containerHeight = container.height;
    // 计算需要压缩的组件高度
    const compressMap = calculateLegendCompress(items, totalHeight, containerHeight, 'height');
    if (compressMap) {
        effectiveTotalHeight = container.height;
    }

    // 计算起始Y位置或bottom值
    let top: number;
    let bottom: number | undefined;
    switch (align) {
        case 'start': {
            top = 0;
            break;
        }
        case 'center': {
            top = Math.floor((container.height - effectiveTotalHeight) / 2);
            break;
        }
        case 'end': {
            // end对齐：从下边开始，使用bottom属性
            bottom = 0;
            top = 0; // 从下往上布局时，从底部第一个组件开始
            break;
        }
        default: {
            top = 0;
            break;
        }
    }

    // 计算X位置
    const layoutBox: BoxLayoutOptionMixin = position === 'right'
        ? { left: gridRect.x + gridRect.width + group.margin }
        : { right: container.width - gridRect.x + group.margin };
    // 布局组件
    if (bottom != null) {
        // end对齐：从下往上布局
        for (let i = items.length - 1; i >= 0; i--) {
            const itemSize = items[i].estimatedSize || {
                width: 0,
                height: 0
            };
            const compressHeight = compressMap?.[i];
            const layoutParams: BoxLayoutOptionMixin = { bottom: bottom, ...layoutBox };
            let itemHeight = itemSize.height;
            if (compressHeight != null) {
                const paddingSum = getPaddingSum(items[i].model, 'height');
                itemHeight = itemHeight - compressHeight;
                // 布局参数的高度是不包含padding的，所以在设置布局参数时需要减去padding。
                layoutParams.height = itemHeight - paddingSum;
            }
            else {
                layoutParams.height = itemHeight;
            }
            items[i].model.setAutoLayoutBoxParams(layoutParams);
            bottom += itemHeight + itemGap;
        }
    }
    else {
        // start或center对齐：从上往下布局
        items.forEach((item, index) => {
            const itemSize = item.estimatedSize || {
                width: 0,
                height: 0
            };
            let itemHeight = itemSize.height;
            const compressHeight = compressMap?.[index];
            const layoutParams: BoxLayoutOptionMixin = { top: top, ...layoutBox };
            if (compressHeight != null) {
                const paddingSum = getPaddingSum(item.model, 'height');
                itemHeight = itemHeight - compressHeight;
                // 布局参数的高度是不包含padding的，所以在设置布局参数时需要减去padding。
                layoutParams.height = itemHeight - paddingSum;
            }
            else {
                layoutParams.height = itemHeight;
            }
            item.model.setAutoLayoutBoxParams(layoutParams);
            top += itemHeight + itemGap;
        });
    }
}

/**
 * 垂直位置多列布局（每个组件一列）。
 *
 * @param group 分组对象。
 * @param container 容器尺寸。
 * @param gridRect 网格矩形。
 */
function layoutLegendVerticalColumns(
    group: LayoutLegendGroup,
    container: { width: number; height: number },
    gridRect: ZRRectLike
) {
    const { position, items, align } = group;
    const itemGap = group.itemGap;

    if (position === 'right') {
        // right位置：从grid右侧开始向右布局
        let left = gridRect.x + gridRect.width + group.margin;
        items.forEach(item => {
            const itemSize = item.estimatedSize || {
                width: 0,
                height: 0
            };

            // 计算Y对齐偏移
            const alignProps = calculateVerticalAlign(align, container.height, itemSize.height);

            const newBox: BoxLayoutOptionMixin = {
                ...alignProps,
                left: left,
            };

            item.model.setAutoLayoutBoxParams(newBox);
            left += itemSize.width + itemGap;
        });
    }
    else {
        // left位置：从grid左侧开始向左布局
        let right = container.width - gridRect.x + group.margin;
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const itemSize = item.estimatedSize || {
                width: 0,
                height: 0
            };

            // 计算Y对齐偏移
            const alignProps = calculateVerticalAlign(align, container.height, itemSize.height);

            const newBox: BoxLayoutOptionMixin = {
                ...alignProps,
                right: right,
            };

            item.model.setAutoLayoutBoxParams(newBox);
            right += itemSize.width + itemGap;
        }
    }
}

// 改进的图例尺寸估算函数（复用现有视图实例）
function estimateLegendSize(
    model: AutoLayoutComponentModel,
    api: ExtensionAPI,
    ecModel: GlobalModel
): { width: number; height: number } {
    try {
        // 使用现有的视图实例进行估算渲染
        const view = api.getViewOfComponentModel(model) as AutoLayoutComponentView;
        if (view && typeof view.renderForEstimate === 'function') {
            // 估算前需要清除之前的自动布局产生的结果，避免影响估算结果
            model.setAutoLayoutBoxParams(undefined);
            const bounds = view.renderForEstimate(model, ecModel, api);
            return applySizeConstraints(model, {
                width: bounds.width,
                height: bounds.height
            });
        }
        else {
            // 如果视图不支持估算，根据组件类型回退到相应的估算方法
            const containerRect = {
                x: 0,
                y: 0,
                width: api.getWidth(),
                height: api.getHeight()
            };
            let estimatedSize: { width: number; height: number };
            if (model.mainType === 'legend') {
                estimatedSize = estimateLegendSizeFallback(model as LegendModel, containerRect);
            }
            else if (model.mainType === 'visualMap') {
                estimatedSize = estimateVisualMapSizeFallback(model as VisualMapModel, containerRect);
            }
            else {
                // 未知组件类型，没有尺寸
                estimatedSize = {
                    width: 0,
                    height: 0
                };
            }

            return applySizeConstraints(model, estimatedSize);
        }
    }
    catch (error) {
        const containerRect = {
            x: 0,
            y: 0,
            width: api.getWidth(),
            height: api.getHeight()
        };
        // 如果估算失败，根据组件类型回退到相应的估算方法
        console.warn('Component view estimation failed, falling back to estimation', error);
        let estimatedSize: { width: number; height: number };
        if (model.mainType === 'legend') {
            // 图例组件类型，使用图例估算方法
            estimatedSize = estimateLegendSizeFallback(model as LegendModel, containerRect);
        }
        else if (model.mainType === 'visualMap') {
            // 视觉映射组件类型，使用视觉映射估算方法
            estimatedSize = estimateVisualMapSizeFallback(model as VisualMapModel, containerRect);
        }
        else {
            estimatedSize = {
                // 未知组件类型，没有尺寸
                width: 0,
                height: 0
            };
        }

        return applySizeConstraints(model, estimatedSize);
    }
}

// 视觉映射组件尺寸估算回退方法
function estimateVisualMapSizeFallback(
    model: VisualMapModel,
    container: { width: number; height: number }
): { width: number; height: number } {
    const orient = model.get('orient');
    const itemWidth = model.get('itemWidth');
    const itemHeight = model.get('itemHeight');
    const textGap = model.get('textGap') || 10;

    // 获取文本样式模型
    const textStyleModel = model.getModel('textStyle');

    // 估算文本尺寸
    function estimateTextSize(text: string): { width: number; height: number } {
        const tempText = new graphic.Text();
        const style = createTextStyle(textStyleModel, {
            text: text,
            fill: 'transparent' // 不渲染，仅用于尺寸计算
        });
        tempText.useStyle(style);
        tempText.update();
        const rect = tempText.getBoundingRect();
        return { width: rect.width, height: rect.height };
    }

    // 获取最小和最大值文本
    const minValue = model.get('min');
    const maxValue = model.get('max');
    const minText = minValue != null ? String(minValue) : '';
    const maxText = maxValue != null ? String(maxValue) : '';

    const minTextSize = estimateTextSize(minText);
    const maxTextSize = estimateTextSize(maxText);
    const maxTextWidth = Math.max(minTextSize.width, maxTextSize.width);
    const textHeight = Math.max(minTextSize.height, maxTextSize.height);

    if (orient === 'horizontal') {
        // 水平视觉映射：宽度为主，高度为次
        const defaultWidth = Math.max(container.width * 0.6, 200); // 默认宽度
        const defaultHeight = 40; // 默认高度

        const contentWidth = itemWidth || defaultWidth;
        const contentHeight = itemHeight || defaultHeight;

        // 总宽度 = 内容宽度 + 文本间距 + 文本宽度
        const totalWidth = contentWidth + textGap + maxTextWidth;
        const totalHeight = Math.max(contentHeight, textHeight);

        return {
            width: Math.min(totalWidth, container.width),
            height: totalHeight
        };
    }
    else {
        // 垂直视觉映射：高度为主，宽度为次
        const defaultHeight = Math.max(container.height * 0.4, 150); // 默认高度
        const defaultWidth = 60; // 默认宽度

        const contentHeight = itemHeight || defaultHeight;
        const contentWidth = itemWidth || defaultWidth;

        // 总高度 = 内容高度 + 文本间距 + 文本高度
        const totalHeight = contentHeight + textGap + textHeight;
        const totalWidth = Math.max(contentWidth, maxTextWidth);

        return {
            width: totalWidth,
            height: Math.min(totalHeight, container.height)
        };
    }
}

/**
 * 图例组件尺寸估算回退方法。
 *
 * @param model 图例模型。
 * @param container 容器尺寸。
 * @returns 估算的尺寸。
 */
function estimateLegendSizeFallback(
    model: LegendModel,
    container: { width: number; height: number }
): { width: number; height: number } {
    const orient = model.get('orient');
    const data = model.get('data') || [];
    const itemHeight = model.get('itemHeight') || 14;
    const itemGap = model.get('itemGap') || 10;
    const selector = model.get('selector');
    const selectorItemGap = model.get('selectorItemGap') || 10;
    const selectorButtonGap = model.get('selectorButtonGap') || 10;

    // 获取文本样式模型（用于准确的文本尺寸估算）
    const textStyleModel = model.getModel('textStyle');
    const formatter = model.get('formatter');

    // 创建临时文本元素来准确估算文本尺寸
    function estimateTextSize(text: string): { width: number; height: number } {
        // 使用图形工具创建临时文本元素
        const tempText = new graphic.Text();
        const style = createTextStyle(textStyleModel, {
            text: text,
            fill: 'transparent' // 不渲染，仅用于尺寸计算
        });
        tempText.useStyle(style);
        tempText.update();
        const rect = tempText.getBoundingRect();
        return { width: rect.width, height: rect.height };
    }

    // 获取格式化后的文本
    function getFormattedText(item: any): string {
        let content = item.name || item.text || item.toString();
        if (zrUtil.isString(formatter) && formatter) {
            content = formatter.replace('{name}', content);
        }
        else if (zrUtil.isFunction(formatter)) {
            content = formatter(content);
        }
        return content;
    }

    // 估算内容区域尺寸
    let contentWidth = 0;
    let contentHeight = 0;

    if (data.length > 0) {
        // 估算每行/列的最大宽度和高度
        let maxItemWidth = 0;
        let maxItemHeight = 0;

        data.forEach((item: any) => {
            const text = getFormattedText(item);
            const textSize = estimateTextSize(text);

            // 图例项宽度 = 图标宽度 + 文本宽度 + 间距
            const itemWidth = model.get('itemWidth') || 25;
            const itemTotalWidth = itemWidth + textSize.width + 5; // 5px 间距
            const itemTotalHeight = Math.max(itemHeight, textSize.height);

            maxItemWidth = Math.max(maxItemWidth, itemTotalWidth);
            maxItemHeight = Math.max(maxItemHeight, itemTotalHeight);
        });

        if (orient === 'horizontal') {
            // 水平布局：估算行数和总宽度
            const itemsPerRow = Math.floor(container.width / (maxItemWidth + itemGap));
            const rowCount = Math.ceil(data.length / Math.max(1, itemsPerRow));

            contentWidth = Math.min(
                data.length * (maxItemWidth + itemGap) - itemGap, // 单行最大宽度
                container.width // 容器限制
            );
            contentHeight = rowCount * maxItemHeight + (rowCount - 1) * itemGap;
        }
        else {
            // 垂直布局：估算列数和总高度
            const itemsPerCol = Math.floor(container.height / (maxItemHeight + itemGap));
            const colCount = Math.ceil(data.length / Math.max(1, itemsPerCol));

            contentHeight = Math.min(
                data.length * (maxItemHeight + itemGap) - itemGap, // 单列最大高度
                container.height // 容器限制
            );
            contentWidth = colCount * maxItemWidth + (colCount - 1) * itemGap;
        }
    }

    // 如果有 selector，估算其尺寸
    let selectorWidth = 0;
    let selectorHeight = 0;
    if (selector) {
        const selectorCount = zrUtil.isArray(selector) ? selector.length : 2; // 按钮数量
        selectorWidth = orient === 'horizontal'
            ? selectorCount * 60 + (selectorCount - 1) * selectorItemGap
            : 60; // 估算按钮宽度
        selectorHeight = orient === 'horizontal'
            ? 20
            : selectorCount * 20 + (selectorCount - 1) * selectorItemGap; // 估算高度
    }

    // 总尺寸计算
    const totalWidth = orient === 'horizontal'
        ? contentWidth + (selector ? selectorButtonGap + selectorWidth : 0)
        : Math.max(contentWidth, selectorWidth);
    const totalHeight = orient === 'horizontal'
        ? Math.max(contentHeight, selectorHeight)
        : contentHeight + (selector ? selectorButtonGap + selectorHeight : 0);

    return {
        width: totalWidth,
        height: totalHeight
    };
}

/**
 * 根据目标坐标系的位置，计算当前坐标系需要图例挤压的空间。
 *
 * @param originalContext 原始上下文
 * @param coordSys 当前坐标系统
 * @param targetCoordSys 目标坐标系统
 * @param position 图例位置
 * @returns 调整后的上下文，如果不需要调整则返回 undefined
 */
export function calculateLegendCompressForCoordSys(
    originalContext: LayoutLegendContext,
    coordSys: LegendAvoidableCoordinateSystem,
    targetRect: RectLike,
    position: string
): LayoutLegendContext | undefined {
    const originMargin = originalContext.margin;
    // 如果原始上下文没有 margin，说明不需要调整
    if (!originMargin || originMargin.every(m => m === 0)) {
        return undefined;
    }

    const coordSysRect = coordSys.getOuterBoundingRect();

    switch (position) {
        case 'bottom': {
            // 计算当前坐标系统下边界到目标坐标系统下边界的距离
            const coordSysBottom = coordSysRect.y + coordSysRect.height;
            const targetBottom = targetRect.y + targetRect.height;
            const distance = coordSysBottom - targetBottom;

            const requiredAdjustment = Math.max(0, originMargin[2] + distance);
            if (requiredAdjustment > 0) {
                const adjustedMargin = [...originMargin];
                adjustedMargin[2] = requiredAdjustment;
                return {
                    needLayout: false,
                    margin: adjustedMargin
                };
            }
            break;
        }
        case 'top': {
            // 计算目标坐标系统上边界到当前坐标系统上边界的距离
            const targetTop = targetRect.y;
            const coordSysTop = coordSysRect.y;
            const distance = coordSysTop - targetTop;

            const requiredAdjustment = Math.max(0, originMargin[0] - distance);
            if (requiredAdjustment > 0) {
                const adjustedMargin = [...originMargin];
                adjustedMargin[0] = requiredAdjustment;
                return {
                    needLayout: false,
                    margin: adjustedMargin
                };
            }
            break;
        }
        case 'left': {
            // 计算目标坐标系统左边界到当前坐标系统左边界的距离
            const targetLeft = targetRect.x;
            const coordSysLeft = coordSysRect.x;
            const distance = coordSysLeft - targetLeft;

            const requiredAdjustment = Math.max(0, originMargin[3] - distance);
            if (requiredAdjustment > 0) {
                const adjustedMargin = [...originMargin];
                adjustedMargin[3] = requiredAdjustment;
                return {
                    needLayout: false,
                    margin: adjustedMargin
                };
            }
            break;
        }
        case 'right': {
            // 计算当前坐标系统右边界到目标坐标系统右边界的距离
            const coordSysRight = coordSysRect.x + coordSysRect.width;
            const targetRight = targetRect.x + targetRect.width;
            const distance = coordSysRight - targetRight;

            // 需要压缩的空间 = max(0, originMargin[1] + distance)
            // 如果当前坐标系统在目标左侧(distance < 0)，已提供提前压缩，所以减少需要调整的量
            const requiredAdjustment = Math.max(0, originMargin[1] + distance);
            if (requiredAdjustment > 0) {
                const adjustedMargin = [...originMargin];
                adjustedMargin[1] = requiredAdjustment;
                return {
                    needLayout: false,
                    margin: adjustedMargin
                };
            }
            break;
        }
    }

    // 如果不需要调整，返回 undefined
    return undefined;
}


/**
 * 计算包含轴标签的扩展边界矩形。
 *
 * 计算包含基础边界矩形和轴标签边界矩形的联合矩形。
 *
 * @param baseRect 基础边界矩形
 * @param axes 轴的集合，可以是数组或映射对象
 * @param axisBuilderSharedCtx 轴构建器共享上下文
 * @returns 包含所有轴标签的扩展边界矩形
 */
export function calculateRectWithAxisLabels(
    baseRect: ZRRectLike,
    axes: Axis[] | { [key: string]: Axis[] },
    axisBuilderSharedCtx: AxisBuilderSharedContext
): ZRRectLike {
    // 收集所有标签布局信息
    const labelLayouts: Array<{ rect: ZRRectLike; textAlign?: string }> = [];

    // 辅助函数：处理单个轴
    const processAxis = (axis: Axis) => {
        if (axis.model.getShallow('show') === false) {
            return;
        }

        const sharedRecord = axisBuilderSharedCtx.ensureRecord(axis.model);
        const labelInfoList = sharedRecord.labelInfoList;
        if (labelInfoList) {
            for (let idx = 0; idx < labelInfoList.length; idx++) {
                const labelInfo = labelInfoList[idx];
                const rect = labelInfo.rect;
                // 跳过无效的矩形
                if (rect.width <= 0 || rect.height <= 0) {
                    continue;
                }
                // 从ZRText中提取textAlign
                let textAlign = labelInfo.label.style.align;
                // 坐标轴标签右对齐时需要使用左对齐的方式计算尺寸
                if (textAlign === 'right') {
                    textAlign = 'left';
                }
                labelLayouts.push({ rect, textAlign });
            }
        }

        const nameLayout = sharedRecord.nameLayout;
        if (nameLayout) {
            const rect = nameLayout.rect;
            // 跳过无效的矩形
            if (rect.width > 0 && rect.height > 0) {
                // 从ZRText中提取textAlign
                let textAlign = nameLayout.label.style.align;
                // 坐标轴标签右对齐时需要使用左对齐的方式计算尺寸
                if (textAlign === 'right') {
                    textAlign = 'left';
                }
                labelLayouts.push({ rect, textAlign });
            }
        }
    };

    // 遍历轴集合
    if (Array.isArray(axes)) {
        // 数组形式：直接遍历
        axes.forEach(processAxis);
    }
    else {
        // 映射对象形式：遍历每个轴列表
        each(axes, (axisList) => {
            each(axisList, processAxis);
        });
    }

    // 使用统一的边界计算方法
    return calculateOuterBoundingRectWithLabels(baseRect, labelLayouts);
}

/**
 * 计算包含标签的扩展边界矩形。
 *
 * 计算包含基础边界矩形和标签边界矩形的联合矩形。
 *
 * @param baseRect 基础边界矩形（例如扇形或图形元素的边界矩形）
 * @param labelLayouts 标签布局列表，每个布局包含 rect 和 textAlign 属性
 * @returns 包含所有标签的扩展边界矩形
 */
export function calculateOuterBoundingRectWithLabels(
    baseRect: ZRRectLike,
    labelLayouts: Array<{ rect: ZRRectLike; textAlign?: string }>
): BoundingRect {
    let minX = baseRect.x;
    let minY = baseRect.y;
    let maxX = baseRect.x + baseRect.width;
    let maxY = baseRect.y + baseRect.height;

    // 遍历所有标签布局，逐个处理标签的边界
    if (labelLayouts) {
        for (let idx = 0; idx < labelLayouts.length; idx++) {
            const labelLayout = labelLayouts[idx];
            const rect = labelLayout.rect;
            const align = labelLayout.textAlign ?? 'left';

            // 跳过无效的矩形
            if (rect.width <= 0 || rect.height <= 0) {
                continue;
            }

            // 根据对齐方式计算真正的边界
            let labelLeftX: number;
            let labelRightX: number;

            switch (align) {
                case 'left': {
                    // 左对齐：rect.x 就是左边界，右边界需要加上宽度
                    labelLeftX = rect.x;
                    labelRightX = rect.x + rect.width;
                    break;
                }
                case 'center': {
                    // 居中对齐：rect.x 是中心点
                    labelLeftX = rect.x - rect.width / 2;
                    labelRightX = rect.x + rect.width / 2;
                    break;
                }
                // 默认为 right
                case 'right': {
                    // 右对齐：rect.x 是右边界，左边界需要减去宽度
                    labelLeftX = rect.x - rect.width;
                    labelRightX = rect.x;
                    break;
                }
            }

            minX = Math.min(minX, labelLeftX);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, labelRightX);
            maxY = Math.max(maxY, rect.y + rect.height);
        }
    }

    return new BoundingRect(minX, minY, maxX - minX, maxY - minY);
}

/**
 * 通过中心点和半径计算圆形布局的外边界矩形。
 *
 * 这是一个工具函数，用于将圆形布局（中心点+半径）转换为边界矩形。
 * 适用于 gauge、pie、chord 等圆形图表。
 *
 * @param cx 中心点 x 坐标
 * @param cy 中心点 y 坐标
 * @param r 半径
 * @returns 圆形布局的外边界矩形
 */
export function calculateCircularBoundingRect(
    cx: number,
    cy: number,
    r: number
): BoundingRect {
    return new BoundingRect(
        cx - r,
        cy - r,
        r * 2,
        r * 2
    );
}

/**
 * 计算标签的全局边界矩形。
 *
 * 这是一个高级工具函数，封装了标签边界计算的完整流程。
 * 函数内部会处理：
 * 1. 获取标签状态模型
 * 2. 创建文本样式
 * 3. 创建并配置临时标签对象
 * 4. 计算边界矩形
 *
 * @param props 标签属性对象
 * @param itemModel 数据项模型（用于获取标签状态模型）
 * @param opt 可选的标签几何计算选项，如果不提供则使用默认配置
 * @returns 标签的全局边界矩形
 */
export function calculateLabelBoundingRect(
    props: LabelBoundingRectProps,
    itemModel: Model<any>,
    opt?: Pick<LabelLayoutData, 'marginForce' | 'minMarginForce' | 'marginDefault'>
): BoundingRect {
    // 获取标签状态模型
    const labelStatesModels = getLabelStatesModels(itemModel);
    const normalModel = labelStatesModels.normal;

    // 创建文本样式
    const textStyle = createTextStyle(
        normalModel as any,
        {
            align: props.align as any,
            verticalAlign: props.verticalAlign as any,
            text: props.text || ''
        },
        null,
        false,
        false
    );

    // 创建并配置临时标签对象
    const tmpLabel = new ZRText();
    tmpLabel.useStyle(textStyle);
    tmpLabel.attr({
        x: props.x,
        y: props.y,
        rotation: props.rotation || 0,
        originX: props.originX ?? props.x,
        originY: props.originY ?? props.y
    });
    tmpLabel.update();

    // 计算边界矩形
    const tmpLabelGeometry: Partial<LabelGeometry> = {
        rect: new BoundingRect(0, 0, 0, 0)
    };
    const computeLabelGeometryOpt = opt || DEFAULT_LABEL_GEOMETRY_OPT;
    const labelGeometry = computeLabelGeometry(tmpLabelGeometry, tmpLabel, computeLabelGeometryOpt);
    return labelGeometry.rect;
}

/**
 * 根据位置和参考矩形计算标签的边界矩形（公共函数）。
 *
 * 这是一个公共函数，用于计算基于位置的标签边界矩形。
 * 统一使用 calculateTextPosition 计算所有 position 类型的文本位置。
 *
 * @param position 位置类型
 * @param referenceRect 参考矩形
 * @param labelModel 标签模型（用于获取字体信息和距离）
 * @param labelText 标签文本内容
 * @returns 标签边界矩形和对齐信息
 */
export function calculateLabelBoundingRectFromPosition(
    position: string,
    referenceRect: BoundingRect,
    labelModel: Model,
    labelText: string
): { rect: BoundingRect; textAlign: string } {
    // 从 labelModel 获取距离配置
    const distance = labelModel.get('distance') || 5;

    // 创建临时标签对象
    const tmpLabel = new graphic.Text({
        style: {
            text: labelText,
            fontSize: labelModel.get('fontSize') || 12,
            fontFamily: labelModel.get('fontFamily') || 'sans-serif',
            fontWeight: labelModel.get('fontWeight') || 'normal'
        }
    });

    const labelRect = tmpLabel.getBoundingRect();

    // 使用 calculateTextPosition 计算文本位置
    const textPositionResult: TextPositionCalculationResult = {
        x: 0,
        y: 0,
        align: 'center',
        verticalAlign: 'middle'
    };
    const elementTextConfig = {
        position: position as BuiltinTextPosition | (number | string)[],
        distance: distance
    };

    calculateTextPosition(
        textPositionResult,
        elementTextConfig,
        referenceRect
    );

    const labelX = textPositionResult.x;
    const labelY = textPositionResult.y;

    // 根据 position 计算标签边界矩形
    switch (position) {
        case 'start': {
            return {
                rect: new BoundingRect(
                    labelX - distance - labelRect.width,
                    labelY - labelRect.height / 2,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        case 'middle': {
            return {
                rect: new BoundingRect(
                    labelX - labelRect.width / 2,
                    labelY - distance - labelRect.height,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        case 'end': {
            return {
                rect: new BoundingRect(
                    labelX + distance,
                    labelY - labelRect.height / 2,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        case 'top': {
            return {
                rect: new BoundingRect(
                    labelX,
                    labelY - labelRect.height,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        case 'bottom': {
            return {
                rect: new BoundingRect(
                    labelX,
                    labelY,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        case 'left': {
            return {
                rect: new BoundingRect(
                    labelX - labelRect.width,
                    labelY,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        case 'right': {
            return {
                rect: new BoundingRect(
                    labelX,
                    labelY,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        case 'inside': {
            return {
                rect: new BoundingRect(
                    labelX - labelRect.width / 2,
                    labelY - labelRect.height / 2,
                    labelRect.width,
                    labelRect.height
                ),
                textAlign: 'left'
            };
        }
        default: {
            if (__DEV__) {
                console.warn(`Unsupported position: ${position}`);
            }
            return null;
        }
    }
}


/**
 * 合并两个外边界矩形，返回并集矩形。
 *
 * @param rect1 第一个矩形
 * @param rect2 第二个矩形
 * @returns 合并后的并集矩形
 */
function mergeBoundingRects(rect1: RectLike, rect2: RectLike): RectLike {
    if (!rect1) {
        return rect2;
    }
    if (!rect2) {
        return rect1;
    }

    const minX = Math.min(rect1.x, rect2.x);
    const minY = Math.min(rect1.y, rect2.y);
    const maxX = Math.max(rect1.x + rect1.width, rect2.x + rect2.width);
    const maxY = Math.max(rect1.y + rect1.height, rect2.y + rect2.height);

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}

/**
 * 应用padding到矩形，返回扩展后的矩形。
 *
 * @param mainRect 主矩形
 * @param model 组件模型，包含padding配置
 * @returns 应用padding后的矩形
 */
export function applyPaddingToRect(mainRect: ZRRectLike, model: ComponentModel): ZRRectLike {
    const padding = formatUtil.normalizeCssArray((model as any).get('padding') || 0);

    return {
        x: mainRect.x - padding[3],
        y: mainRect.y - padding[0],
        width: mainRect.width + padding[1] + padding[3],
        height: mainRect.height + padding[0] + padding[2]
    };
}

/**
 * 收集指定坐标系中的系列。
 *
 * @param ecModel 全局模型。
 * @param coordSys 要检查的坐标系，如果提供则只返回使用该坐标系的系列。
 * @returns 指定坐标系的系列列表。
 */
export function collectCoordLabelSeries(
    ecModel: GlobalModel,
    coordSys?: LegendAvoidableCoordinateSystem
): SeriesModel[] {
    const seriesList = ecModel.getSeries();
    if (!seriesList || seriesList.length === 0) {
        return [];
    }

    const resultSeries: SeriesModel[] = [];

    each(seriesList, (seriesModel) => {
        // 如果指定了坐标系，只收集使用该坐标系的系列
        if (coordSys) {
            const seriesCoordSys = seriesModel.coordinateSystem as any;
            if (seriesCoordSys && (seriesCoordSys === coordSys || seriesCoordSys.master === coordSys)) {
                resultSeries.push(seriesModel);
            }
        }
        else {
            resultSeries.push(seriesModel);
        }
    });

    return resultSeries;
}

/**
 * 根据符号类型、点坐标和符号大小计算符号边界矩形。
 *
 * 这是一个辅助函数，用于根据符号类型计算边界矩形。
 * 支持 pin、arrow 等特殊符号类型的特殊边界计算。
 *
 * @param symbolType 符号类型
 * @param point 数据点坐标 [x, y]
 * @param symbolSize 符号大小 [width, height]
 * @returns 符号边界矩形
 */
export function calculateSymbolRectFromParams(
    symbolType: string,
    point: number[],
    symbolSize: number[]
): BoundingRect {
    const [width, height] = symbolSize;
    switch (symbolType) {
        case 'pin': {
            return new BoundingRect(
                point[0] - width / 2,
                point[1] - height,
                width,
                height
            );
        }
        case 'arrow': {
            return new BoundingRect(
                point[0] - width / 2,
                point[1],
                width,
                height
            );
        }
        default: {
            return new BoundingRect(
                point[0] - width / 2,
                point[1] - height / 2,
                width,
                height
            );
        }
    }
}

/**
 * 计算某个数据点对应的符号（symbol）的边界矩形。
 * 本方法支持优先从系列视图对象中直接获取（如果支持自定义），
 * 否则回退到通用符号类型和大小的推断逻辑，保证大多数场景下都能计算得到。
 *
 * 详细逻辑流程：
 * 1. 优先支持视图层自定义：如系列自定义了 getSymbolRect，即用于特殊场景或定制符号渲染时，
 *    可直接拿到精准的符号外接矩形，提升精准度和灵活性。
 * 2. 若视图层无法提供，退回到数据视觉设定的 symbol/symbolSize —— 设计时需兼容视觉通道优先级与“全局-局部”联动。
 * 3. 若类型为 'none'，认为该点没有可视符号，直接返回 null，便于后续分支显示控制。
 * 4. 如果符号大小未定义，才查找系列级设定（既支持静态数值又支持回调函数），
 *    默认回退到常用的标准大小 8，提升鲁棒性。
 * 5. 最后统一归一化符号大小，调用通用的参数计算方法，保证最终返回的 BoundingRect 可用于布局等后续操作。
 *
 * @param seriesModel 当前数据所属系列的系列模型
 * @param data 当前系列的数据对象
 * @param dataIndex 当前数据的索引
 * @param point 当前数据点在像素坐标系上的位置
 * @param api 提供获取视图（view）、模型等 API
 * @returns 符号边界矩形或 null
 */
export function calculateSymbolRect(
    seriesModel: SeriesModel,
    data: SeriesData,
    dataIndex: number,
    point: number[],
    api: ExtensionAPI
): BoundingRect | null {
    // 步骤1：优先尝试从视图对象直接获取符号外接矩形（支持自定义符号几何，场景如 scatter3D/自定义组件等）
    const view = api.getViewOfSeriesModel(seriesModel);
    if (isSymbolRectProvider(view)) {
        const symbolRect = view.getSymbolRect(seriesModel, dataIndex, api.getModel());
        // 若视图对象已能提供，有直接返回，增强拓展性
        if (symbolRect) {
            return symbolRect;
        }
    }

    // 步骤2：从数据视觉属性中获取符号类型。不存在时默认使用 'circle'
    const symbolType = data.getItemVisual(dataIndex, 'symbol') as string || 'circle';
    // 若显式声明为 'none'，该数据点不渲染符号，返回 null
    if (symbolType === 'none') {
        return null;
    }

    // 步骤3：判定并获取符号大小，优先使用数据视觉指定（例如视觉映射），否则退到系列配置
    let symbolSizeValue = data.getItemVisual(dataIndex, 'symbolSize');
    if (symbolSizeValue == null) {
        // 检查系列配置：既兼容常量，也兼容回调函数（如动态根据数值映射符号大小）
        const seriesSymbolSize = (seriesModel as any).get('symbolSize');
        if (typeof seriesSymbolSize === 'function') {
            // 回调函数时，需将原始数值和上下文参数一并传入
            const dataValue = seriesModel.getRawValue(dataIndex);
            symbolSizeValue = seriesSymbolSize(dataValue, {
                dataIndex: dataIndex,
                seriesModel: seriesModel,
                data: data
            });
        }
        else {
            symbolSizeValue = seriesSymbolSize;
        }
    }
    // 若相关配置和视觉通道都未指定，最后使用兜底值 8
    if (symbolSizeValue == null) {
        symbolSizeValue = 8;
    }

    // 步骤4：统一归一化符号尺寸（数组/数值通用），保证后续计算可用
    const symbolSize = symbolUtil.normalizeSymbolSize(symbolSizeValue as number | number[]);

    // 步骤5：调用通用参数方法，获取最终符号外接矩形
    return calculateSymbolRectFromParams(symbolType, point, symbolSize);
}

/**
 * 统一的系列标签边界矩形计算方法。
 *
 * @param seriesModels 系列模型列表
 * @param api ExtensionAPI 实例（必须，用于 markLine/markPoint）
 * @param options 配置选项
 * @param options.getDataItems 获取数据项的函数
 * @param options.positionHandler 位置处理函数（可选，不提供则使用默认笛卡尔坐标系逻辑）
 * @returns 标签边界矩形和对齐信息列表
 */
export function calculateSeriesLabelBoundingRects(
    seriesModels: SeriesModel[],
    api: ExtensionAPI,
    getDataItems: (seriesModel: SeriesModel, data: any) => Array<{
        dataIndex: number;
        point: number[];
        symbolRect: BoundingRect;
        labelText: string;
        extraFormatParams?: any;
    }>
): Array<{
    rect: BoundingRect;
    textAlign: string;
}> {
    const result: Array<{
        rect: BoundingRect;
        textAlign: string;
    }> = [];

    each(seriesModels, function (seriesModel) {
        const labelStatesModels = getLabelStatesModels(seriesModel);
        const labelModel = labelStatesModels.normal;

        // Process data labels if show is enabled and position is not inside
        if (labelModel.get('show')) {
            const position = labelModel.get('position') || 'top';

            if (position !== 'inside') {
                const data = seriesModel.getData();
                const dataItems = getDataItems(seriesModel, data);

                // Process each data item
                for (let i = 0; i < dataItems.length; i++) {
                    const item = dataItems[i];
                    const { symbolRect, labelText } = item;

                    if (labelText == null || labelText === '') {
                        continue;
                    }

                    const boundingRectResult = calculateLabelBoundingRectFromPosition(
                        position as string,
                        symbolRect,
                        labelModel,
                        labelText
                    );
                    boundingRectResult && result.push(boundingRectResult);
                }
            }
        }

        // Process markLine labels
        const mlModel = MarkerModel.getMarkerModelFromSeries(seriesModel, 'markLine') as MarkLineModel;
        if (mlModel) {
            const mlView = api.getViewOfComponentModel(mlModel.parentModel as ComponentModel) as MarkLineView;
            if (mlView) {
                const mlRects = mlView.getLabelBoundingRect(seriesModel, mlModel, api);
                result.push(...mlRects);
            }
        }

        // Process markPoint labels
        const mpModel = MarkerModel.getMarkerModelFromSeries(seriesModel, 'markPoint') as MarkPointModel;
        if (mpModel) {
            const mpView = api.getViewOfComponentModel(mpModel.parentModel as ComponentModel) as MarkPointView;
            if (mpView) {
                const mpRects = mpView.getLabelBoundingRect(seriesModel, mpModel, api);
                result.push(...mpRects);
            }
        }
    });

    return result;
}

/**
 * 计算所有序列标签超出参考矩形的外扩边距（返回需要的margin调整）。
 *
 * 此函数主要用于确定标签文本等元素是否有超出（比如series图表的label超过绘图区或
 * 者坐标系区域），从而可以自动调整外层布局或留白，避免内容被裁切。注意返回值为
 * 四边分别所需的最大外扩量。
 *
 * 传入的一组labelBoundingRects包含所有已计算位置的标签边界及其对齐方式（一般由
 * 布局模块获得）， referenceRect为希望标签全部显示在其内部的参考矩形（如绘图区
 * 或坐标系框）。返回的数组格式为 [上, 右, 下, 左]，每个方向代表所有标签中该方向
 * 的最大超出量，需要相应地扩展margin。
 *
 * @param labelBoundingRects  标签的边界信息（带对齐），一般由label位置排布算法
 * 批量生成
 * @param referenceRect       参考矩形，如坐标系主区域，用于判定"超出"
 * @returns                   需要补偿的margin: [top, right, bottom, left]
 */
export function calculateSeriesLabelOverflowMargin(
    labelBoundingRects: Array<{
        rect: BoundingRect;
        textAlign: string;
    }>,
    referenceRect: ZRRectLike
): number[] {
    const margin = [0, 0, 0, 0]; // [top, right, bottom, left]

    each(labelBoundingRects, function (labelInfo) {
        const positionedRect = labelInfo.rect;

        // Calculate overflow on each side
        const leftOverflow = referenceRect.x - positionedRect.x;
        const rightOverflow = (positionedRect.x + positionedRect.width) - (referenceRect.x + referenceRect.width);
        const topOverflow = referenceRect.y - positionedRect.y;
        const bottomOverflow = (positionedRect.y + positionedRect.height) - (referenceRect.y + referenceRect.height);

        // Update margin with maximum overflow values
        margin[3] = Math.max(margin[3], leftOverflow);   // left
        margin[1] = Math.max(margin[1], rightOverflow);  // right
        margin[0] = Math.max(margin[0], topOverflow);    // top
        margin[2] = Math.max(margin[2], bottomOverflow); // bottom
    });

    return margin;
}

/**
 * 计算从 baseRect 扩展到 expandedRect 需要补偿的 margin 边距。
 *
 * 本函数常用于判断由于新加标签、修饰或标尺等元素导致外部矩形（expandedRect）包裹内容
 * 较原始矩形（baseRect）增大时，需要在每个方向（上右下左）分别增加多少 margin 来维持内容不被裁切。
 *
 * 设计要点：
 * - margin为[上, 右, 下, 左]，仅返回正向（向外扩张）的margin值。
 * - 若 expandedRect 在某方向比 baseRect 更靠外，则该方向的 margin 为正值。
 * - 若 expandedRect 比 baseRect 小，margin为0，不向内缩。
 *
 * @param baseRect 原始矩形
 * @param expandedRect 扩展后的矩形（包含附加元素）
 * @returns 需要从base扩展到expanded时补偿的margin数组 [上, 右, 下, 左]
 */
export function calculateRectExpansionMargin(
    baseRect: ZRRectLike,
    expandedRect: ZRRectLike
): number[] {
    const margin = [0, 0, 0, 0]; // [top, right, bottom, left]

    // 计算每一侧 expandedRect 比 baseRect 向外扩展了多少。若为负数则为收缩，忽略为0。
    const leftExpansion = baseRect.x - expandedRect.x;
    const rightExpansion = (expandedRect.x + expandedRect.width) - (baseRect.x + baseRect.width);
    const topExpansion = baseRect.y - expandedRect.y;
    const bottomExpansion = (expandedRect.y + expandedRect.height) - (baseRect.y + baseRect.height);

    // 只统计外扩的部分，不会通过 margin 向内收缩（效果是最大化区域包容性）
    margin[3] = Math.max(0, leftExpansion);   // 左边如果 expandedRect.x 更靠左，需要补margin
    margin[1] = Math.max(0, rightExpansion);  // 右边如果 expandedRect 更宽，需要补margin
    margin[0] = Math.max(0, topExpansion);    // 上方外扩
    margin[2] = Math.max(0, bottomExpansion); // 下方外扩

    return margin;
}

/**
 * 针对雷达图、极坐标等环形布局场景，将矩形的 [top, right, bottom, left] margin
 * 转换为新的圆心和新的半径，实现布局自动缩放与居中调整。
 *
 * 主要用途：
 * - 由于标签等内容导致环形区域需要外扩，自动平衡中心点和半径，避免内容溢出。
 * - 按照 margin 差异微调中心位置，并扣减最大方向的半径，保障不同方向都有最小留白。
 * - radiusReduction 会取垂直与水平方向平均 margin 中的较大者，使得最终圆可以完整包裹内容。
 * - 防止极端情况下半径过度缩小，始终留有最小半径间隔。
 *
 * @param margin        [top, right, bottom, left] 方向的 margin 调整量
 * @param cx            当前的圆心 X 坐标
 * @param cy            当前的圆心 Y 坐标
 * @param r             当前的外半径
 * @param r0            当前的内半径（对 radar 可为 0）
 * @param minRadiusDiff 允许的最小半径间距，防止半径变成负值或太小，默认10
 * @returns             调整后的{cx, cy, r}
 */
export function applyMarginToCircularLayout(
    margin: number[],
    cx: number,
    cy: number,
    r: number,
    r0: number,
    minRadiusDiff: number = 10
): { cx: number, cy: number, r: number } {
    // 按 margin 左右差、上下差，分别平衡调整中心点，保证视觉尽量居中
    const newCx = cx + (margin[3] - margin[1]) / 2; // 左大于右，则向右偏移，反之亦然
    const newCy = cy + (margin[0] - margin[2]) / 2; // 上大于下，则向下偏移

    // 垂直方向(上+下)、水平方向(左+右)分别取平均，取最大者认为限制半径缩小量
    const verticalAvg = (margin[0] + margin[2]) / 2;
    const horizontalAvg = (margin[1] + margin[3]) / 2;
    const radiusReduction = Math.max(verticalAvg, horizontalAvg);

    // 保留极限最小宽度，防止圆半径减到负数或极小导致布局错乱
    let newR = r;
    if (radiusReduction > 0) {
        const actualReduction = Math.min(radiusReduction, r - r0 - minRadiusDiff);
        newR = Math.max(r - actualReduction, r0 + minRadiusDiff);
    }

    return {
        cx: newCx,
        cy: newCy,
        r: newR
    };
}

/**
 * 判断 margin 是否全部为零，常用于判断布局是否已经收敛无需扩展。
 *
 * 对于自动布局算法，可以决定是否跳过一步无效的margin处理或缩放。
 *
 * @param margin 四方向 margin 数组 [top, right, bottom, left]
 * @returns 全为 0 则返回 true，否则返回 false
 */
export function isMarginAllZero(margin: number[]): boolean {
    return margin[0] === 0 && margin[1] === 0 && margin[2] === 0 && margin[3] === 0;
}