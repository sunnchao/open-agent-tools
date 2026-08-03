import { Annotation, StateGraph } from "@langchain/langgraph";

const annotation = Annotation.Root({
  message: Annotation<string>({
    reducer: (current, update) => update ?? current,
    default: () => "",
  }),
});
const langgraph = new StateGraph(annotation);

langgraph
  .addNode("node1", (state, config) => {
    console.log("node1", state, config.configurable);
    return {
      message: "我是 node1 message",
    };
  })
  .addEdge("__start__", "node1");

const app = langgraph.compile();
const result = await app.invoke({
  message: "hello world",
});

console.log("result", result);
