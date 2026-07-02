import SubnetGame from "./SubnetGame";
export default function App() {
  return <SubnetGame onRoundEnd={(r) => console.log("round result:", r)} />;
}