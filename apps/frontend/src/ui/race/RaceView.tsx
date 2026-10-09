import { WorldBuilder } from './WorldBuilder';
import { Seeds } from './Seeds';
import { RaceMap } from './RaceMap';
import { PositionChart } from './PositionChart';
import { StintTimeline } from './StintTimeline';
import { DecisionPanel } from './DecisionPanel';
import { Scoreboard } from './Scoreboard';
import { FuelTyres } from './FuelTyres';
import { RaceTable } from './RaceTable';
import { ParameterCards } from './ParameterCards';
import { AuditLog } from './AuditLog';
import { WeatherPanel } from './WeatherPanel';

export function RaceView() {
  return (
    <div className="grid gap-3 p-3 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-[300px_minmax(0,1fr)_420px]">
      <div className="flex flex-col gap-3 order-2 2xl:order-1 min-w-0">
        <WorldBuilder />
        <Seeds />
        <WeatherPanel />
        <RaceTable />
      </div>
      <div className="flex flex-col gap-3 order-1 lg:col-span-2 2xl:col-span-1 2xl:order-2 min-w-0">
        <RaceMap />
        <PositionChart />
        <StintTimeline />
        <ParameterCards />
      </div>
      <div className="flex flex-col gap-3 order-3 min-w-0">
        <DecisionPanel />
        <Scoreboard />
        <FuelTyres />
        <AuditLog />
      </div>
    </div>
  );
}
