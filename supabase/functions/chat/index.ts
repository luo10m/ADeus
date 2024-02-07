import { serve } from "https://deno.land/std@0.170.0/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.26.0/mod.ts";

import { corsHeaders } from "../common/cors.ts";
import { supabaseClient } from "../common/supabaseClient.ts";
import { ApplicationError, UserError } from "../common/errors.ts";

async function callOpenRouter(modelId, messages) {
  // Your OpenRouter API key and other configurations
  const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId, // Use the model ID passed to the function
      messages: messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const completion = await response.json();

  console.log("completion: ", completion)
  const message = completion.choices[0].message
  return message;
}

async function callOpenAI(openaiClient, messages) {

  let completion = await openaiClient.chat.completions.create({
    model: "gpt-4-1106-preview",
    messages: messages,
  });
  console.log("completion: ", completion);
  console.log(
    "completion.choices[0].content: ",
    completion.choices[0].content
  );
  return completion.choices[0].message;
}

const chat = async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const supabaseAuthToken = req.headers.get("Authorization") ?? "";
  if (!supabaseAuthToken)
    throw new ApplicationError("Missing supabase auth token");
  const supabase = supabaseClient(req, supabaseAuthToken);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user)
    throw new ApplicationError(
      "Unable to get auth user details in request data"
    );
  const { messageHistory, useOpenRouter, modelId } = await req.json();
  if (!messageHistory) throw new UserError("Missing query in request data");

  //use this key for embeddings and for model generation
  const openaiClient = new OpenAI({
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  });

  console.log("messageHistory: ", messageHistory);

  // embed the last messageHistory message
  const embeddingsResponse = await openaiClient.embeddings.create({
    model: "text-embedding-ada-002",
    input: messageHistory[messageHistory.length - 1].content,
  });
  const embeddings = embeddingsResponse.data[0].embedding;
  console.log("Embeddings:", embeddings);

  const { data: relevantRecords, error: recordsError } = await supabase.rpc(
    "match_records_embeddings_similarity",
    {
      query_embedding: JSON.stringify(embeddings), // Pass the embedding you want to compare
      match_threshold: 0.8, // Choose an appropriate threshold for your data
      match_count: 10, // Choose the number of matches
    }
  );

  if (recordsError) {
    console.log("recordsError: ", recordsError);
    throw new ApplicationError("Error getting records from Supabase");
  }

  //the messages that are passed in for the prompt
  let messages = [
    {
      role: "system",
      content: `You are a helpful assistant, helping the user navigate through life. He is asking uoi questions, and you answer them with the best of your ability.
      You have access to some of their records, to help you answer their question in a more personalized way.

      Records:
      ${relevantRecords.map((r) => r.raw_text).join("\n")}
        `,
    },
    ...messageHistory,
  ];
  console.log("messages: ", messages);

  //if UseOpenRouter = true generate with OpenRouter, if false generate with OpenAI
  try {
    let responseMessage;
    if (useOpenRouter) {
      responseMessage = await callOpenRouter(modelId, messageHistory);
    } else {
      responseMessage = await callOpenAI(openaiClient, messageHistory);
    }

    return new Response(
      JSON.stringify({
        msg: responseMessage,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
    } catch (error) {
      console.log("Error: ", error);
      throw new ApplicationError("Error processing chat completion");
    }

  return new Response(
    JSON.stringify({
      msg: { role: "assistant", content: "Hello from Deno Deploy!" },
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    }
  );
};

serve(chat);
