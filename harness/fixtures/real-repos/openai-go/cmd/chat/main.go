package main

import (
	"context"

	"github.com/openai/openai-go/v3"
)

func answer(ctx context.Context, prompt string) (string, error) {
	client := openai.NewClient()
	result, err := client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model:    openai.ChatModelGPT5,
		Messages: []openai.ChatCompletionMessageParamUnion{openai.UserMessage(prompt)},
	})
	if err != nil {
		return "", err
	}
	return result.Choices[0].Message.Content, nil
}
