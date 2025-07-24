import { EChartsExtensionInstallRegisters, use } from '../../extension';
import installScrollablePiecewiseAction from './ScrollablePiecewiseAction';
import ScrollablePiecewiseModel from './ScrollablePiecewiseModel';
import { ScrollablePiecewiseView } from './ScrollablePiecewiseView';
import { install as installPiecewise } from './installVisualMapPiecewise';

export function install(registers: EChartsExtensionInstallRegisters) {
    use(installPiecewise);

    registers.registerComponentModel(ScrollablePiecewiseModel);
    registers.registerComponentView(ScrollablePiecewiseView);

    installScrollablePiecewiseAction(registers);
}